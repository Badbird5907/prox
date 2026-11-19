package auth

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// QuotaWindow is one normalized subscription usage window of a credential.
type QuotaWindow struct {
	// ID identifies the window ("5h"/"7d" for Claude, "primary"/"secondary" for Codex).
	ID string `json:"id"`
	// UsedPercent is the consumed share of the window, 0..100.
	UsedPercent float64 `json:"used_percent"`
	// ResetAt is when the window resets; zero when unknown.
	ResetAt time.Time `json:"-"`
	// Period is the window length.
	Period time.Duration `json:"-"`
}

// QuotaObservation is a point-in-time view of a credential's usage windows.
type QuotaObservation struct {
	ObservedAt time.Time
	Windows    []QuotaWindow
	// Plan is the provider plan name when known.
	Plan string
	// Source is "poll" for usage API polls and "headers" for response headers.
	Source string
}

// PoolWindow returns the window with the longest period whose reset is after now.
// Long windows decide when capacity is lost, so they drive reset-aware routing.
func (o QuotaObservation) PoolWindow(now time.Time) (QuotaWindow, bool) {
	var best QuotaWindow
	found := false
	for _, w := range o.Windows {
		if w.Period <= 0 || !w.ResetAt.After(now) {
			continue
		}
		if !found || w.Period > best.Period {
			best, found = w, true
		}
	}
	return best, found
}

// Exhausted reports whether any live window is fully used, and until when.
func (o QuotaObservation) Exhausted(now time.Time) (bool, time.Time) {
	exhausted := false
	var until time.Time
	for _, w := range o.Windows {
		if w.UsedPercent < 100 || !w.ResetAt.After(now) {
			continue
		}
		exhausted = true
		if w.ResetAt.After(until) {
			until = w.ResetAt
		}
	}
	return exhausted, until
}

var quotaObservations = struct {
	sync.RWMutex
	byID map[string]QuotaObservation
}{byID: make(map[string]QuotaObservation)}

// RecordQuotaObservation stores the newest polled observation for an auth ID.
// Older observations never replace newer ones.
func RecordQuotaObservation(authID string, obs QuotaObservation) {
	authID = strings.TrimSpace(authID)
	if authID == "" || obs.ObservedAt.IsZero() {
		return
	}
	obs.Windows = append([]QuotaWindow(nil), obs.Windows...)
	quotaObservations.Lock()
	defer quotaObservations.Unlock()
	if current, ok := quotaObservations.byID[authID]; ok && current.ObservedAt.After(obs.ObservedAt) {
		return
	}
	quotaObservations.byID[authID] = obs
}

// ForgetQuotaObservations drops stored observations for auth IDs not in keep.
func ForgetQuotaObservations(keep map[string]struct{}) {
	quotaObservations.Lock()
	defer quotaObservations.Unlock()
	for id := range quotaObservations.byID {
		if _, ok := keep[id]; !ok {
			delete(quotaObservations.byID, id)
		}
	}
}

func recordedQuotaObservation(authID string) (QuotaObservation, bool) {
	quotaObservations.RLock()
	defer quotaObservations.RUnlock()
	obs, ok := quotaObservations.byID[authID]
	return obs, ok
}

// LatestQuotaObservation returns the freshest known observation for an auth,
// choosing between the last poll and the last upstream response headers.
func LatestQuotaObservation(auth *Auth) (QuotaObservation, bool) {
	if auth == nil {
		return QuotaObservation{}, false
	}
	polled, hasPolled := recordedQuotaObservation(auth.ID)
	fromHeaders, hasHeaders := QuotaObservationFromSignals(auth.Provider, auth.Quota)
	switch {
	case hasPolled && hasHeaders:
		if fromHeaders.ObservedAt.After(polled.ObservedAt) {
			if fromHeaders.Plan == "" {
				fromHeaders.Plan = polled.Plan
			}
			return fromHeaders, true
		}
		return polled, true
	case hasPolled:
		return polled, true
	case hasHeaders:
		return fromHeaders, true
	default:
		return QuotaObservation{}, false
	}
}

// QuotaObservationFromSignals derives usage windows from captured response headers.
func QuotaObservationFromSignals(provider string, q QuotaState) (QuotaObservation, bool) {
	if q.ObservedAt.IsZero() || len(q.Signals) == 0 {
		return QuotaObservation{}, false
	}
	h := make(http.Header, len(q.Signals))
	for k, v := range q.Signals {
		h.Set(k, v)
	}
	obs := QuotaObservation{ObservedAt: q.ObservedAt, Source: "headers"}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "claude":
		for _, spec := range []struct {
			id     string
			period time.Duration
		}{{"5h", 5 * time.Hour}, {"7d", 7 * 24 * time.Hour}} {
			prefix := "Anthropic-Ratelimit-Unified-" + spec.id + "-"
			used, okUsed := parseQuotaFloat(h.Get(prefix + "Utilization"))
			reset, okReset := parseQuotaUnix(h.Get(prefix + "Reset"))
			if !okUsed || !okReset {
				continue
			}
			obs.Windows = append(obs.Windows, QuotaWindow{ID: spec.id, UsedPercent: clampPercent(used * 100), ResetAt: reset, Period: spec.period})
		}
	case "codex":
		// Named additional buckets are model specific, not the shared allowance.
		active := strings.ToLower(h.Get("X-Codex-Active-Limit"))
		if active != "" && active != "codex" && active != "primary" && active != "secondary" {
			return QuotaObservation{}, false
		}
		obs.Plan = strings.TrimSpace(h.Get("X-Codex-Plan-Type"))
		for _, part := range []string{"Primary", "Secondary"} {
			prefix := "X-Codex-" + part + "-"
			used, okUsed := parseQuotaFloat(h.Get(prefix + "Used-Percent"))
			minutes, okMinutes := parseQuotaFloat(h.Get(prefix + "Window-Minutes"))
			if !okUsed || !okMinutes || minutes <= 0 {
				continue
			}
			reset, okReset := parseQuotaUnix(h.Get(prefix + "Reset-At"))
			if !okReset {
				seconds, okAfter := parseQuotaFloat(h.Get(prefix + "Reset-After-Seconds"))
				if !okAfter || seconds <= 0 || seconds > 366*24*60*60 {
					continue
				}
				reset = q.ObservedAt.Add(time.Duration(seconds) * time.Second)
			}
			obs.Windows = append(obs.Windows, QuotaWindow{
				ID:          strings.ToLower(part),
				UsedPercent: clampPercent(used),
				ResetAt:     reset,
				Period:      time.Duration(minutes * float64(time.Minute)),
			})
		}
	default:
		return QuotaObservation{}, false
	}
	if len(obs.Windows) == 0 {
		return QuotaObservation{}, false
	}
	sort.Slice(obs.Windows, func(i, j int) bool { return obs.Windows[i].Period < obs.Windows[j].Period })
	return obs, true
}

func parseQuotaFloat(raw string) (float64, bool) {
	value, errParse := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if errParse != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	return value, true
}

func parseQuotaUnix(raw string) (time.Time, bool) {
	value, errParse := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if errParse != nil || value <= 0 {
		return time.Time{}, false
	}
	return time.Unix(value, 0), true
}

func clampPercent(value float64) float64 {
	return math.Max(0, math.Min(100, value))
}
