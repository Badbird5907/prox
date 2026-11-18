package quotapool

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHistoryStoreRoundTripAcrossDays(t *testing.T) {
	dir := t.TempDir()
	store := newHistoryStore(dir)
	day1 := time.Date(2026, 11, 17, 23, 50, 0, 0, time.UTC)
	day2 := day1.Add(20 * time.Minute)
	records := []historyRecord{
		{ID: "a", Provider: "claude", T: day2.UnixMilli(), Windows: []WindowPoint{{ID: "7d", UsedPercent: 12}}},
		{ID: "a", Provider: "claude", T: day1.UnixMilli(), Windows: []WindowPoint{{ID: "7d", UsedPercent: 10}}},
		{ID: "b", Provider: "codex", T: day2.UnixMilli()},
	}
	if errAppend := store.append(records, day2); errAppend != nil {
		t.Fatalf("append() error = %v", errAppend)
	}
	// A torn line must not hide valid records.
	path := filepath.Join(dir, dayFileName(day2))
	file, errOpen := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if errOpen != nil {
		t.Fatalf("open: %v", errOpen)
	}
	if _, errWrite := file.WriteString("{\"id\":\"a\",\"t\":"); errWrite != nil {
		t.Fatalf("write: %v", errWrite)
	}
	if errClose := file.Close(); errClose != nil {
		t.Fatalf("close: %v", errClose)
	}

	got, errRead := store.read(day1.Add(-time.Minute), day2.Add(time.Minute))
	if errRead != nil {
		t.Fatalf("read() error = %v", errRead)
	}
	if len(got["a"]) != 2 || got["a"][0].T != day1.UnixMilli() || got["a"][1].Windows[0].UsedPercent != 12 {
		t.Fatalf("read()[a] = %+v", got["a"])
	}
	if len(got["b"]) != 1 {
		t.Fatalf("read()[b] = %+v", got["b"])
	}

	narrow, errNarrow := store.read(day2.Add(-time.Minute), day2.Add(time.Minute))
	if errNarrow != nil || len(narrow["a"]) != 1 {
		t.Fatalf("narrow read() = %+v, %v", narrow, errNarrow)
	}
}

func TestHistoryStorePrunesOldFiles(t *testing.T) {
	dir := t.TempDir()
	store := newHistoryStore(dir)
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	old := filepath.Join(dir, dayFileName(now.Add(-60*24*time.Hour)))
	if errWrite := os.WriteFile(old, []byte("{}\n"), 0o600); errWrite != nil {
		t.Fatalf("write: %v", errWrite)
	}
	if errAppend := store.append([]historyRecord{{ID: "a", T: now.UnixMilli()}}, now); errAppend != nil {
		t.Fatalf("append() error = %v", errAppend)
	}
	if _, errStat := os.Stat(old); !os.IsNotExist(errStat) {
		t.Fatalf("old history file not pruned: %v", errStat)
	}
}
