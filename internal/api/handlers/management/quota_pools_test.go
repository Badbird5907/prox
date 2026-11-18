package management

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestParseUnixMilliQuery(t *testing.T) {
	fallback := time.UnixMilli(42)
	if got := parseUnixMilliQuery("", fallback); !got.Equal(fallback) {
		t.Fatalf("empty = %v", got)
	}
	if got := parseUnixMilliQuery("abc", fallback); !got.Equal(fallback) {
		t.Fatalf("invalid = %v", got)
	}
	if got := parseUnixMilliQuery("1763500000000", fallback); got.UnixMilli() != 1763500000000 {
		t.Fatalf("valid = %v", got)
	}
}

func TestGetQuotaPoolsWithoutTracker(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/v8/management/quota/pools", nil)
	(&Handler{}).GetQuotaPools(c)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}
