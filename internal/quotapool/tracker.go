// Package quotapool tracks Claude and Codex subscription usage windows over time.
//
// Observations come from upstream response headers (free) and from read-only
// usage polls for credentials that have not been observed recently. Fresh
// observations feed the soonest-reset routing strategy and are appended to a
// per-day history used by the management quota page.
package quotapool

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/proxyutil"
	log "github.com/sirupsen/logrus"
)

const (
	// PollInterval is how stale an observation may get before the usage endpoint is polled.
	PollInterval = 10 * time.Minute
	// recordInterval throttles history points derived from response headers.
	recordInterval = 2 * time.Minute
	tickInterval   = time.Minute
)

// AuthLister is the subset of the auth manager the tracker needs.
type AuthLister interface {
	List() []*coreauth.Auth
}

type credentialState struct {
	lastPollAttempt time.Time
	lastError       string
	polling         bool
	lastRecordedAt  time.Time
	lastRecordedObs time.Time
	lastResets      map[string]int64
}

// Tracker polls and records usage windows for Claude and Codex credentials.
type Tracker struct {
	auths   AuthLister
	cfgFn   func() *config.Config
	history *historyStore
	nowFunc func() time.Time
	fetch   func(ctx context.Context, client *http.Client, auth *coreauth.Auth, now time.Time) (coreauth.QuotaObservation, error)

	mu     sync.Mutex
	states map[string]*credentialState
}

var current atomic.Pointer[Tracker]

// Current returns the running tracker, or nil when none was started.
func Current() *Tracker {
	return current.Load()
}

// Start creates the process tracker and runs it until ctx is canceled.
func Start(ctx context.Context, auths AuthLister, cfgFn func() *config.Config) *Tracker {
	tracker := NewTracker(auths, cfgFn, historyDir(cfgFn()))
	current.Store(tracker)
	go tracker.run(ctx)
	return tracker
}

// NewTracker builds a tracker that stores history under dir.
func NewTracker(auths AuthLister, cfgFn func() *config.Config, dir string) *Tracker {
	return &Tracker{
		auths:   auths,
		cfgFn:   cfgFn,
		history: newHistoryStore(dir),
		nowFunc: time.Now,
		fetch:   fetchUsage,
		states:  make(map[string]*credentialState),
	}
}

func historyDir(cfg *config.Config) string {
	if cfg == nil {
		return ""
	}
	dir, errResolve := util.ResolveAuthDir(cfg.AuthDir)
	if errResolve != nil || strings.TrimSpace(dir) == "" {
		if writable := util.WritablePath(); writable != "" {
			return filepath.Join(writable, "quota-history")
		}
		if home, errHome := os.UserHomeDir(); errHome == nil {
			return filepath.Join(home, ".cli-proxy-api", "quota-history")
		}
		return ""
	}
	return filepath.Join(dir, "quota-history")
}

func (t *Tracker) now() time.Time {
	if t.nowFunc != nil {
		return t.nowFunc()
	}
	return time.Now()
}

func (t *Tracker) run(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		t.tick(ctx, false)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// trackedAuths returns enabled Claude and Codex OAuth credentials.
func (t *Tracker) trackedAuths() []*coreauth.Auth {
	if t == nil || t.auths == nil {
		return nil
	}
	var out []*coreauth.Auth
	for _, auth := range t.auths.List() {
		if auth == nil {
			continue
		}
		switch strings.ToLower(auth.Provider) {
		case "claude", "codex":
		default:
			continue
		}
		if metadataString(auth, "access_token") == "" {
			continue
		}
		out = append(out, auth)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// tick records header observations and polls stale credentials in the background.
// When force is set every enabled credential is polled and tick waits for the results.
func (t *Tracker) tick(ctx context.Context, force bool) (int, map[string]string) {
	now := t.now()
	auths := t.trackedAuths()
	keep := make(map[string]struct{}, len(auths))
	var records []historyRecord
	var wg sync.WaitGroup
	var refreshed atomic.Int64
	errs := make(map[string]string)
	var errsMu sync.Mutex

	for _, auth := range auths {
		keep[auth.ID] = struct{}{}
		if record, ok := t.recordIfNew(auth, now); ok {
			records = append(records, record)
		}
		if auth.Disabled || auth.Status == coreauth.StatusDisabled {
			continue
		}
		if !t.claimPoll(auth, now, force) {
			continue
		}
		wg.Add(1)
		go func(auth *coreauth.Auth) {
			defer wg.Done()
			errPoll := t.poll(ctx, auth)
			if errPoll != nil {
				errsMu.Lock()
				errs[auth.ID] = errPoll.Error()
				errsMu.Unlock()
				return
			}
			refreshed.Add(1)
		}(auth)
	}
	t.forget(keep)
	if errAppend := t.history.append(records, now); errAppend != nil {
		log.Warnf("quota pool: %v", errAppend)
	}
	if force {
		wg.Wait()
	}
	return int(refreshed.Load()), errs
}

// claimPoll decides whether auth needs a usage poll and marks it in flight.
func (t *Tracker) claimPoll(auth *coreauth.Auth, now time.Time, force bool) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.stateLocked(auth.ID)
	if state.polling {
		return false
	}
	if !force {
		if now.Sub(state.lastPollAttempt) < PollInterval {
			return false
		}
		if obs, ok := coreauth.LatestQuotaObservation(auth); ok && now.Sub(obs.ObservedAt) < PollInterval {
			return false
		}
	}
	state.polling = true
	state.lastPollAttempt = now
	return true
}

func (t *Tracker) poll(ctx context.Context, auth *coreauth.Auth) error {
	client := &http.Client{
		Transport: t.transportFor(auth),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	obs, errFetch := t.fetch(ctx, client, auth, t.now())
	t.mu.Lock()
	state := t.stateLocked(auth.ID)
	state.polling = false
	if errFetch != nil {
		state.lastError = errFetch.Error()
	} else {
		state.lastError = ""
	}
	t.mu.Unlock()
	if errFetch != nil {
		if ctx.Err() == nil {
			log.WithField("provider", auth.Provider).Debugf("quota pool: usage poll failed: %v", errFetch)
		}
		return errFetch
	}
	coreauth.RecordQuotaObservation(auth.ID, obs)
	if record, ok := t.recordIfNew(auth, t.now()); ok {
		if errAppend := t.history.append([]historyRecord{record}, t.now()); errAppend != nil {
			log.Warnf("quota pool: %v", errAppend)
		}
	}
	return nil
}

func (t *Tracker) transportFor(auth *coreauth.Auth) http.RoundTripper {
	proxyURL := strings.TrimSpace(auth.ProxyURL)
	if proxyURL == "" && t.cfgFn != nil {
		if cfg := t.cfgFn(); cfg != nil {
			proxyURL = strings.TrimSpace(cfg.ProxyURL)
		}
	}
	if proxyURL != "" {
		transport, _, errTransport := proxyutil.BuildHTTPTransport(proxyURL)
		if errTransport == nil && transport != nil {
			return transport
		}
		log.Warn("quota pool: invalid proxy configuration; using direct connection")
	}
	return http.DefaultTransport
}

// recordIfNew returns a history record when auth has an observation newer than
// the last recorded one and the throttle allows it (resets always record).
func (t *Tracker) recordIfNew(auth *coreauth.Auth, now time.Time) (historyRecord, bool) {
	obs, ok := coreauth.LatestQuotaObservation(auth)
	if !ok {
		return historyRecord{}, false
	}
	resets := make(map[string]int64, len(obs.Windows))
	for _, w := range obs.Windows {
		resets[w.ID] = w.ResetAt.Unix()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.stateLocked(auth.ID)
	if !obs.ObservedAt.After(state.lastRecordedObs) {
		return historyRecord{}, false
	}
	resetChanged := false
	for id, reset := range resets {
		if prev, okPrev := state.lastResets[id]; !okPrev || absInt64(prev-reset) > 60 {
			resetChanged = true
			break
		}
	}
	if !resetChanged && now.Sub(state.lastRecordedAt) < recordInterval {
		return historyRecord{}, false
	}
	state.lastRecordedAt = now
	state.lastRecordedObs = obs.ObservedAt
	state.lastResets = resets
	return historyRecord{
		ID:       auth.ID,
		Provider: strings.ToLower(auth.Provider),
		T:        obs.ObservedAt.UnixMilli(),
		Windows:  windowPoints(obs.Windows),
	}, true
}

func (t *Tracker) stateLocked(id string) *credentialState {
	state, ok := t.states[id]
	if !ok {
		state = &credentialState{}
		t.states[id] = state
	}
	return state
}

func (t *Tracker) forget(keep map[string]struct{}) {
	t.mu.Lock()
	for id := range t.states {
		if _, ok := keep[id]; !ok {
			delete(t.states, id)
		}
	}
	t.mu.Unlock()
	coreauth.ForgetQuotaObservations(keep)
}

// RefreshAll polls every enabled tracked credential now and waits for the results.
func (t *Tracker) RefreshAll(ctx context.Context) (int, map[string]string) {
	if t == nil {
		return 0, map[string]string{}
	}
	return t.tick(ctx, true)
}

func windowPoints(windows []coreauth.QuotaWindow) []WindowPoint {
	out := make([]WindowPoint, 0, len(windows))
	for _, w := range windows {
		point := WindowPoint{ID: w.ID, UsedPercent: w.UsedPercent, PeriodSeconds: int64(w.Period / time.Second)}
		if !w.ResetAt.IsZero() {
			point.ResetAt = w.ResetAt.UnixMilli()
		}
		out = append(out, point)
	}
	return out
}

func absInt64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
