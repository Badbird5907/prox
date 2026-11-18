package quotapool

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/MoeForge/moego/json"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

const (
	claudeUsageURL       = "https://api.anthropic.com/api/oauth/usage"
	claudeUsageUserAgent = "claude-cli/2.1.280 (external, cli)"
	codexUsageURL        = "https://chatgpt.com/backend-api/wham/usage"
	codexUsageUserAgent  = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)"
	maxUsageBodyBytes    = 1 << 20
)

// fetchUsage polls the provider usage endpoint for one credential.
func fetchUsage(ctx context.Context, client *http.Client, auth *coreauth.Auth, now time.Time) (coreauth.QuotaObservation, error) {
	token := metadataString(auth, "access_token")
	if token == "" {
		return coreauth.QuotaObservation{}, fmt.Errorf("credential has no access token")
	}
	switch strings.ToLower(auth.Provider) {
	case "claude":
		return fetchClaudeUsage(ctx, client, token, now)
	case "codex":
		return fetchCodexUsage(ctx, client, token, metadataString(auth, "account_id"), now)
	default:
		return coreauth.QuotaObservation{}, fmt.Errorf("provider %q has no usage endpoint", auth.Provider)
	}
}

func fetchClaudeUsage(ctx context.Context, client *http.Client, token string, now time.Time) (coreauth.QuotaObservation, error) {
	type window struct {
		Utilization *float64 `json:"utilization"`
		ResetsAt    string   `json:"resets_at"`
	}
	var payload struct {
		FiveHour *window `json:"five_hour"`
		SevenDay *window `json:"seven_day"`
	}
	headers := map[string]string{
		"Authorization":  "Bearer " + token,
		"Anthropic-Beta": "oauth-2025-04-20",
		"User-Agent":     claudeUsageUserAgent,
	}
	if errGet := getJSON(ctx, client, claudeUsageURL, headers, &payload); errGet != nil {
		return coreauth.QuotaObservation{}, errGet
	}
	obs := coreauth.QuotaObservation{ObservedAt: now, Source: "poll"}
	for _, spec := range []struct {
		id     string
		period time.Duration
		w      *window
	}{{"5h", 5 * time.Hour, payload.FiveHour}, {"7d", 7 * 24 * time.Hour, payload.SevenDay}} {
		if spec.w == nil || spec.w.Utilization == nil {
			continue
		}
		w := coreauth.QuotaWindow{ID: spec.id, UsedPercent: clamp(*spec.w.Utilization), Period: spec.period}
		if reset, errParse := time.Parse(time.RFC3339Nano, strings.TrimSpace(spec.w.ResetsAt)); errParse == nil {
			w.ResetAt = reset
		}
		obs.Windows = append(obs.Windows, w)
	}
	if len(obs.Windows) == 0 {
		return coreauth.QuotaObservation{}, fmt.Errorf("usage response has no windows")
	}
	return obs, nil
}

func fetchCodexUsage(ctx context.Context, client *http.Client, token, accountID string, now time.Time) (coreauth.QuotaObservation, error) {
	type window struct {
		UsedPercent        *float64 `json:"used_percent"`
		LimitWindowSeconds int64    `json:"limit_window_seconds"`
		ResetAt            int64    `json:"reset_at"`
		ResetAfterSeconds  int64    `json:"reset_after_seconds"`
	}
	var payload struct {
		PlanType  string `json:"plan_type"`
		RateLimit *struct {
			Primary   *window `json:"primary_window"`
			Secondary *window `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"User-Agent":    codexUsageUserAgent,
	}
	if accountID != "" {
		headers["Chatgpt-Account-Id"] = accountID
	}
	if errGet := getJSON(ctx, client, codexUsageURL, headers, &payload); errGet != nil {
		return coreauth.QuotaObservation{}, errGet
	}
	obs := coreauth.QuotaObservation{ObservedAt: now, Source: "poll", Plan: strings.TrimSpace(payload.PlanType)}
	if payload.RateLimit != nil {
		for _, spec := range []struct {
			id string
			w  *window
		}{{"primary", payload.RateLimit.Primary}, {"secondary", payload.RateLimit.Secondary}} {
			if spec.w == nil || spec.w.UsedPercent == nil || spec.w.LimitWindowSeconds <= 0 {
				continue
			}
			w := coreauth.QuotaWindow{
				ID:          spec.id,
				UsedPercent: clamp(*spec.w.UsedPercent),
				Period:      time.Duration(spec.w.LimitWindowSeconds) * time.Second,
			}
			switch {
			case spec.w.ResetAt > 0:
				w.ResetAt = time.Unix(spec.w.ResetAt, 0)
			case spec.w.ResetAfterSeconds > 0:
				w.ResetAt = now.Add(time.Duration(spec.w.ResetAfterSeconds) * time.Second)
			}
			obs.Windows = append(obs.Windows, w)
		}
	}
	if len(obs.Windows) == 0 {
		return coreauth.QuotaObservation{}, fmt.Errorf("usage response has no windows")
	}
	return obs, nil
}

func getJSON(ctx context.Context, client *http.Client, url string, headers map[string]string, target any) error {
	req, errRequest := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if errRequest != nil {
		return fmt.Errorf("build usage request: %w", errRequest)
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, errDo := client.Do(req)
	if errDo != nil {
		return fmt.Errorf("usage request failed: %w", errDo)
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Debugf("quota pool: close usage response: %v", errClose)
		}
	}()
	body, errRead := io.ReadAll(io.LimitReader(resp.Body, maxUsageBodyBytes))
	if errRead != nil {
		return fmt.Errorf("read usage response: %w", errRead)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("usage endpoint returned status %d", resp.StatusCode)
	}
	if errDecode := json.Unmarshal(body, target); errDecode != nil {
		return fmt.Errorf("decode usage response: %w", errDecode)
	}
	return nil
}

func metadataString(auth *coreauth.Auth, key string) string {
	if auth == nil || auth.Metadata == nil {
		return ""
	}
	value, _ := auth.Metadata[key].(string)
	return strings.TrimSpace(value)
}

func clamp(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}
