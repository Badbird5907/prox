package quotapool

import (
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// CredentialView is the management view of one tracked credential.
type CredentialView struct {
	ID         string        `json:"id"`
	AuthIndex  string        `json:"auth_index"`
	Name       string        `json:"name"`
	Provider   string        `json:"provider"`
	Email      string        `json:"email"`
	Label      string        `json:"label"`
	Plan       string        `json:"plan"`
	Disabled   bool          `json:"disabled"`
	ObservedAt *int64        `json:"observed_at"`
	Source     string        `json:"source"`
	Error      string        `json:"error"`
	Windows    []WindowPoint `json:"windows"`
}

// HistoryPoint is one recorded observation.
type HistoryPoint struct {
	T       int64         `json:"t"`
	Windows []WindowPoint `json:"windows"`
}

// CredentialHistory is the recorded series of one credential.
type CredentialHistory struct {
	ID     string         `json:"id"`
	Points []HistoryPoint `json:"points"`
}

// Snapshot is the management quota pool response.
type Snapshot struct {
	Now                 int64               `json:"now"`
	Strategy            string              `json:"strategy"`
	PollIntervalSeconds int64               `json:"poll_interval_seconds"`
	Credentials         []CredentialView    `json:"credentials"`
	History             []CredentialHistory `json:"history"`
}

// Snapshot returns current windows for all tracked credentials plus history in [from, to].
func (t *Tracker) Snapshot(from, to time.Time) (Snapshot, error) {
	now := t.now()
	out := Snapshot{
		Now:                 now.UnixMilli(),
		PollIntervalSeconds: int64(PollInterval / time.Second),
		Credentials:         []CredentialView{},
		History:             []CredentialHistory{},
	}
	if t.cfgFn != nil {
		if cfg := t.cfgFn(); cfg != nil {
			out.Strategy = strings.TrimSpace(cfg.Routing.Strategy)
		}
	}
	if out.Strategy == "" {
		out.Strategy = "round-robin"
	}
	auths := t.trackedAuths()
	for _, auth := range auths {
		auth.EnsureIndex()
		view := CredentialView{
			ID:        auth.ID,
			AuthIndex: auth.Index,
			Name:      firstNonEmpty(auth.FileName, auth.ID),
			Provider:  strings.ToLower(auth.Provider),
			Email:     metadataString(auth, "email"),
			Label:     strings.TrimSpace(auth.Label),
			Plan:      metadataString(auth, "plan_type"),
			Disabled:  auth.Disabled || auth.Status == coreauth.StatusDisabled,
			Windows:   []WindowPoint{},
		}
		if obs, ok := coreauth.LatestQuotaObservation(auth); ok {
			observed := obs.ObservedAt.UnixMilli()
			view.ObservedAt = &observed
			view.Source = obs.Source
			view.Windows = windowPoints(obs.Windows)
			if obs.Plan != "" {
				view.Plan = obs.Plan
			}
		}
		t.mu.Lock()
		if state, ok := t.states[auth.ID]; ok {
			view.Error = state.lastError
		}
		t.mu.Unlock()
		out.Credentials = append(out.Credentials, view)
	}

	records, errRead := t.history.read(from, to)
	if errRead != nil {
		return out, errRead
	}
	for _, auth := range auths {
		series := records[auth.ID]
		if len(series) == 0 {
			continue
		}
		history := CredentialHistory{ID: auth.ID, Points: make([]HistoryPoint, 0, len(series))}
		for _, record := range series {
			history.Points = append(history.Points, HistoryPoint{T: record.T, Windows: record.Windows})
		}
		out.History = append(out.History, history)
	}
	return out, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
