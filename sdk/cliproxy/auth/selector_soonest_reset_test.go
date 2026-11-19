package auth

import (
	"context"
	"strconv"
	"testing"
	"time"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func recordWeekly(t *testing.T, id string, now time.Time, used float64, resetIn time.Duration) {
	t.Helper()
	RecordQuotaObservation(id, QuotaObservation{
		ObservedAt: now.Add(-time.Minute),
		Source:     "poll",
		Windows: []QuotaWindow{
			{ID: "5h", UsedPercent: 10, ResetAt: now.Add(2 * time.Hour), Period: 5 * time.Hour},
			{ID: "7d", UsedPercent: used, ResetAt: now.Add(resetIn), Period: 7 * 24 * time.Hour},
		},
	})
	t.Cleanup(func() { ForgetQuotaObservations(map[string]struct{}{}) })
}

func TestSoonestResetSelectorPicksEarliestWeeklyReset(t *testing.T) {
	now := time.Now()
	selector := &SoonestResetSelector{nowFunc: func() time.Time { return now }}
	recordWeekly(t, "soonest-a", now, 20, 4*24*time.Hour)
	recordWeekly(t, "soonest-b", now, 70, 22*time.Hour)
	recordWeekly(t, "soonest-c", now, 5, 3*24*time.Hour)
	auths := []*Auth{{ID: "soonest-a", Provider: "claude"}, {ID: "soonest-b", Provider: "claude"}, {ID: "soonest-c", Provider: "claude"}}

	for i := 0; i < 3; i++ {
		got, errPick := selector.Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, auths)
		if errPick != nil {
			t.Fatalf("Pick() error = %v", errPick)
		}
		if got.ID != "soonest-b" {
			t.Fatalf("Pick() = %q, want soonest-b", got.ID)
		}
	}
}

func TestSoonestResetSelectorSkipsExhaustedWindow(t *testing.T) {
	now := time.Now()
	selector := &SoonestResetSelector{nowFunc: func() time.Time { return now }}
	recordWeekly(t, "exhausted-a", now, 100, 10*time.Hour)
	recordWeekly(t, "exhausted-b", now, 30, 5*24*time.Hour)
	auths := []*Auth{{ID: "exhausted-a", Provider: "claude"}, {ID: "exhausted-b", Provider: "claude"}}

	got, errPick := selector.Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, auths)
	if errPick != nil {
		t.Fatalf("Pick() error = %v", errPick)
	}
	if got.ID != "exhausted-b" {
		t.Fatalf("Pick() = %q, want exhausted-b", got.ID)
	}
}

func TestSoonestResetSelectorAllExhaustedReturnsCooldown(t *testing.T) {
	now := time.Now()
	selector := &SoonestResetSelector{nowFunc: func() time.Time { return now }}
	recordWeekly(t, "cool-a", now, 100, 10*time.Hour)
	auths := []*Auth{{ID: "cool-a", Provider: "claude"}}

	if _, errPick := selector.Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, auths); errPick == nil {
		t.Fatal("Pick() error = nil, want cooldown error")
	}
}

func TestSoonestResetSelectorPrefersObservedOverUnknown(t *testing.T) {
	now := time.Now()
	selector := &SoonestResetSelector{nowFunc: func() time.Time { return now }}
	recordWeekly(t, "known-z", now, 50, 6*24*time.Hour)
	auths := []*Auth{{ID: "unknown-a", Provider: "codex"}, {ID: "known-z", Provider: "codex"}}

	got, errPick := selector.Pick(context.Background(), "codex", "", cliproxyexecutor.Options{}, auths)
	if errPick != nil {
		t.Fatalf("Pick() error = %v", errPick)
	}
	if got.ID != "known-z" {
		t.Fatalf("Pick() = %q, want known-z", got.ID)
	}
}

func TestSoonestResetSelectorRotatesWhenNothingObserved(t *testing.T) {
	selector := &SoonestResetSelector{}
	auths := []*Auth{{ID: "rr-a", Provider: "gemini"}, {ID: "rr-b", Provider: "gemini"}}
	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		got, errPick := selector.Pick(context.Background(), "gemini", "", cliproxyexecutor.Options{}, auths)
		if errPick != nil {
			t.Fatalf("Pick() error = %v", errPick)
		}
		seen[got.ID] = true
	}
	if len(seen) != 2 {
		t.Fatalf("round-robin fallback picked %v, want both credentials", seen)
	}
}

func TestSoonestResetSelectorUsesResponseHeaders(t *testing.T) {
	now := time.Now()
	selector := &SoonestResetSelector{nowFunc: func() time.Time { return now }}
	headerAuth := func(id string, resetIn time.Duration) *Auth {
		return &Auth{ID: id, Provider: "codex", Quota: QuotaState{
			ObservedAt: now.Add(-time.Minute),
			Signals: map[string]string{
				"X-Codex-Secondary-Used-Percent":   "40",
				"X-Codex-Secondary-Window-Minutes": "10080",
				"X-Codex-Secondary-Reset-At":       strconv.FormatInt(now.Add(resetIn).Unix(), 10),
			},
		}}
	}
	auths := []*Auth{headerAuth("hdr-a", 5*24*time.Hour), headerAuth("hdr-b", 30*time.Hour)}

	got, errPick := selector.Pick(context.Background(), "codex", "", cliproxyexecutor.Options{}, auths)
	if errPick != nil {
		t.Fatalf("Pick() error = %v", errPick)
	}
	if got.ID != "hdr-b" {
		t.Fatalf("Pick() = %q, want hdr-b", got.ID)
	}
}

func TestQuotaObservationFromClaudeSignals(t *testing.T) {
	now := time.Now()
	reset := now.Add(3 * 24 * time.Hour).Unix()
	obs, ok := QuotaObservationFromSignals("claude", QuotaState{ObservedAt: now, Signals: map[string]string{
		"Anthropic-Ratelimit-Unified-7d-Utilization": "0.42",
		"Anthropic-Ratelimit-Unified-7d-Reset":       strconv.FormatInt(reset, 10),
	}})
	if !ok {
		t.Fatal("QuotaObservationFromSignals() ok = false")
	}
	window, found := obs.PoolWindow(now)
	if !found || window.ID != "7d" || window.UsedPercent != 42 || window.ResetAt.Unix() != reset {
		t.Fatalf("PoolWindow() = %+v, %v", window, found)
	}
}

func TestLatestQuotaObservationPrefersNewest(t *testing.T) {
	now := time.Now()
	recordWeekly(t, "newest", now.Add(-time.Hour), 10, 2*24*time.Hour)
	auth := &Auth{ID: "newest", Provider: "claude", Quota: QuotaState{ObservedAt: now, Signals: map[string]string{
		"Anthropic-Ratelimit-Unified-7d-Utilization": "0.5",
		"Anthropic-Ratelimit-Unified-7d-Reset":       strconv.FormatInt(now.Add(time.Hour).Unix(), 10),
	}}}
	obs, ok := LatestQuotaObservation(auth)
	if !ok || obs.Source != "headers" {
		t.Fatalf("LatestQuotaObservation() = %+v, %v; want header observation", obs, ok)
	}
}
