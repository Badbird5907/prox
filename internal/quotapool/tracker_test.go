package quotapool

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type staticAuths []*coreauth.Auth

func (s staticAuths) List() []*coreauth.Auth { return s }

func newTestTracker(t *testing.T, auths staticAuths, now *time.Time) (*Tracker, *atomic.Int64) {
	t.Helper()
	t.Cleanup(func() { coreauth.ForgetQuotaObservations(map[string]struct{}{}) })
	cfg := &config.Config{}
	cfg.Routing.Strategy = "soonest-reset"
	tracker := NewTracker(auths, func() *config.Config { return cfg }, t.TempDir())
	tracker.nowFunc = func() time.Time { return *now }
	calls := &atomic.Int64{}
	tracker.fetch = func(_ context.Context, _ *http.Client, auth *coreauth.Auth, at time.Time) (coreauth.QuotaObservation, error) {
		calls.Add(1)
		if auth.ID == "broken" {
			return coreauth.QuotaObservation{}, errors.New("usage endpoint returned status 401")
		}
		return coreauth.QuotaObservation{ObservedAt: at, Source: "poll", Plan: "pro", Windows: []coreauth.QuotaWindow{
			{ID: "secondary", UsedPercent: 25, ResetAt: at.Add(48 * time.Hour), Period: 7 * 24 * time.Hour},
		}}, nil
	}
	return tracker, calls
}

func oauthAuth(id, provider string) *coreauth.Auth {
	return &coreauth.Auth{ID: id, Provider: provider, FileName: id, Metadata: map[string]any{"access_token": "tok", "email": id + "@example.com"}}
}

func TestTrackerRefreshAllPollsAndRecordsHistory(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	auths := staticAuths{oauthAuth("codex-a.json", "codex"), oauthAuth("broken", "claude"), {ID: "gemini", Provider: "gemini"}}
	tracker, calls := newTestTracker(t, auths, &now)

	refreshed, errs := tracker.RefreshAll(context.Background())
	if refreshed != 1 || len(errs) != 1 || errs["broken"] == "" {
		t.Fatalf("RefreshAll() = %d, %v", refreshed, errs)
	}
	if calls.Load() != 2 {
		t.Fatalf("fetch calls = %d, want 2 (gemini is not tracked)", calls.Load())
	}

	snapshot, errSnapshot := tracker.Snapshot(now.Add(-time.Hour), now.Add(time.Hour))
	if errSnapshot != nil {
		t.Fatalf("Snapshot() error = %v", errSnapshot)
	}
	if snapshot.Strategy != "soonest-reset" || len(snapshot.Credentials) != 2 {
		t.Fatalf("Snapshot() = %+v", snapshot)
	}
	var codex CredentialView
	for _, view := range snapshot.Credentials {
		if view.ID == "codex-a.json" {
			codex = view
		}
		if view.ID == "broken" && view.Error == "" {
			t.Fatal("broken credential error not reported")
		}
	}
	if codex.Plan != "pro" || len(codex.Windows) != 1 || codex.Windows[0].PeriodSeconds != 604800 || codex.ObservedAt == nil {
		t.Fatalf("codex view = %+v", codex)
	}
	if len(snapshot.History) != 1 || len(snapshot.History[0].Points) != 1 {
		t.Fatalf("history = %+v", snapshot.History)
	}
}

func TestTrackerTickSkipsFreshObservations(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	tracker, calls := newTestTracker(t, staticAuths{oauthAuth("codex-a.json", "codex")}, &now)

	tracker.RefreshAll(context.Background())
	now = now.Add(5 * time.Minute)
	tracker.tick(context.Background(), false)
	if calls.Load() != 1 {
		t.Fatalf("fetch calls = %d, want 1 while observation is fresh", calls.Load())
	}
}

func TestTrackerRecordsHeaderObservationsWithThrottle(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	auth := oauthAuth("claude-a.json", "claude")
	tracker, _ := newTestTracker(t, staticAuths{auth}, &now)
	reset := now.Add(72 * time.Hour).Unix()
	setHeaders := func(at time.Time, util string) {
		auth.Quota = coreauth.QuotaState{ObservedAt: at, Signals: map[string]string{
			"Anthropic-Ratelimit-Unified-7d-Utilization": util,
			"Anthropic-Ratelimit-Unified-7d-Reset":       strconv.FormatInt(reset, 10),
		}}
	}
	setHeaders(now, "0.10")
	if _, ok := tracker.recordIfNew(auth, now); !ok {
		t.Fatal("first header observation not recorded")
	}
	setHeaders(now.Add(30*time.Second), "0.11")
	if _, ok := tracker.recordIfNew(auth, now.Add(30*time.Second)); ok {
		t.Fatal("observation inside throttle window recorded")
	}
	setHeaders(now.Add(3*time.Minute), "0.12")
	if _, ok := tracker.recordIfNew(auth, now.Add(3*time.Minute)); !ok {
		t.Fatal("observation after throttle window not recorded")
	}
}
