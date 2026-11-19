package auth

import (
	"context"
	"time"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// soonestResetFreshness bounds how old an observation may be before the
// credential is treated as unknown.
const soonestResetFreshness = 30 * time.Minute

// SoonestResetSelector drains the credential whose long quota window resets
// first. Quota left in a window when it resets is lost, so spending the
// soonest-resetting allowance first maximizes total usable capacity.
//
// Credentials without a fresh observation are only used when no observed
// credential is usable; they then rotate round-robin. It uses the custom
// selector path because scheduler snapshots carry no quota observations.
type SoonestResetSelector struct {
	fallback RoundRobinSelector
	nowFunc  func() time.Time
}

// Pick selects the eligible credential whose pool window resets soonest.
func (s *SoonestResetSelector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*Auth) (*Auth, error) {
	now := time.Now()
	if s.nowFunc != nil {
		now = s.nowFunc()
	}
	available, errAvailable := getSelectorAvailableAuths(ctx, auths, provider, model, now)
	if errAvailable != nil {
		return nil, errAvailable
	}
	available = preferCodexWebsocketAuths(ctx, provider, available)

	var best *Auth
	var bestReset time.Time
	bestUsed := -1.0
	var earliestRecovery time.Time
	usable := make([]*Auth, 0, len(available))
	for _, candidate := range available {
		obs, ok := LatestQuotaObservation(candidate)
		if !ok || obs.ObservedAt.After(now.Add(time.Minute)) || now.Sub(obs.ObservedAt) > soonestResetFreshness {
			usable = append(usable, candidate)
			continue
		}
		if exhausted, until := obs.Exhausted(now); exhausted {
			if earliestRecovery.IsZero() || until.Before(earliestRecovery) {
				earliestRecovery = until
			}
			continue
		}
		usable = append(usable, candidate)
		window, hasWindow := obs.PoolWindow(now)
		if !hasWindow {
			continue
		}
		if best == nil || window.ResetAt.Before(bestReset) ||
			(window.ResetAt.Equal(bestReset) && (window.UsedPercent > bestUsed ||
				(window.UsedPercent == bestUsed && candidate.ID < best.ID))) {
			best, bestReset, bestUsed = candidate, window.ResetAt, window.UsedPercent
		}
	}
	if best != nil {
		return best, nil
	}
	if len(usable) == 0 {
		return nil, newModelCooldownError(model, provider, earliestRecovery.Sub(now))
	}
	return s.fallback.Pick(ctx, provider, model, opts, usable)
}
