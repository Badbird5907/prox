package management

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotapool"
)

const (
	defaultQuotaHistoryRange = 7 * 24 * time.Hour
	maxQuotaHistoryRange     = 40 * 24 * time.Hour
)

// GetQuotaPools returns tracked Claude/Codex usage windows and their recorded history.
// Query parameters "from" and "to" are unix milliseconds bounding the history range.
func (h *Handler) GetQuotaPools(c *gin.Context) {
	tracker := quotapool.Current()
	if tracker == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota tracking is not running"})
		return
	}
	now := time.Now()
	to := parseUnixMilliQuery(c.Query("to"), now)
	from := parseUnixMilliQuery(c.Query("from"), to.Add(-defaultQuotaHistoryRange))
	if to.Before(from) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from must not be after to"})
		return
	}
	if to.Sub(from) > maxQuotaHistoryRange {
		from = to.Add(-maxQuotaHistoryRange)
	}
	snapshot, errSnapshot := tracker.Snapshot(from, to)
	if errSnapshot != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read quota history"})
		return
	}
	c.JSON(http.StatusOK, snapshot)
}

// RefreshQuotaPools polls the usage endpoint of every enabled tracked credential.
func (h *Handler) RefreshQuotaPools(c *gin.Context) {
	tracker := quotapool.Current()
	if tracker == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota tracking is not running"})
		return
	}
	refreshed, errs := tracker.RefreshAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"refreshed": refreshed, "errors": errs})
}

func parseUnixMilliQuery(raw string, fallback time.Time) time.Time {
	value, errParse := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if errParse != nil || value <= 0 {
		return fallback
	}
	return time.UnixMilli(value)
}
