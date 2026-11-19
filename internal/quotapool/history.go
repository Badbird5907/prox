package quotapool

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/MoeForge/moego/json"
	log "github.com/sirupsen/logrus"
)

const historyRetention = 35 * 24 * time.Hour

// WindowPoint is a serialized usage window.
type WindowPoint struct {
	ID            string  `json:"id"`
	UsedPercent   float64 `json:"used_percent"`
	ResetAt       int64   `json:"reset_at"`
	PeriodSeconds int64   `json:"period_seconds"`
}

// historyRecord is one line of a history file.
type historyRecord struct {
	ID       string        `json:"id"`
	Provider string        `json:"provider"`
	T        int64         `json:"t"`
	Windows  []WindowPoint `json:"windows"`
}

// historyStore appends usage points to one JSONL file per UTC day.
type historyStore struct {
	mu         sync.Mutex
	dir        string
	lastPruned time.Time
}

func newHistoryStore(dir string) *historyStore {
	return &historyStore{dir: dir}
}

func dayFileName(t time.Time) string {
	return t.UTC().Format("2006-01-02") + ".jsonl"
}

func (s *historyStore) append(records []historyRecord, now time.Time) error {
	if s == nil || s.dir == "" || len(records) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if errMkdir := os.MkdirAll(s.dir, 0o700); errMkdir != nil {
		return fmt.Errorf("create quota history dir: %w", errMkdir)
	}
	byDay := make(map[string][]historyRecord)
	for _, record := range records {
		name := dayFileName(time.UnixMilli(record.T))
		byDay[name] = append(byDay[name], record)
	}
	for name, dayRecords := range byDay {
		if errWrite := s.appendFile(filepath.Join(s.dir, name), dayRecords); errWrite != nil {
			return errWrite
		}
	}
	if now.Sub(s.lastPruned) > 6*time.Hour {
		s.lastPruned = now
		s.pruneLocked(now)
	}
	return nil
}

func (s *historyStore) appendFile(path string, records []historyRecord) (errOut error) {
	file, errOpen := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if errOpen != nil {
		return fmt.Errorf("open quota history file: %w", errOpen)
	}
	defer func() {
		if errClose := file.Close(); errClose != nil && errOut == nil {
			errOut = fmt.Errorf("close quota history file: %w", errClose)
		}
	}()
	writer := bufio.NewWriter(file)
	for _, record := range records {
		line, errMarshal := json.Marshal(record)
		if errMarshal != nil {
			return fmt.Errorf("encode quota history record: %w", errMarshal)
		}
		if _, errWrite := writer.Write(append(line, '\n')); errWrite != nil {
			return fmt.Errorf("write quota history record: %w", errWrite)
		}
	}
	if errFlush := writer.Flush(); errFlush != nil {
		return fmt.Errorf("flush quota history file: %w", errFlush)
	}
	return nil
}

func (s *historyStore) pruneLocked(now time.Time) {
	entries, errRead := os.ReadDir(s.dir)
	if errRead != nil {
		return
	}
	cutoff := now.Add(-historyRetention).UTC().Format("2006-01-02")
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		if strings.TrimSuffix(name, ".jsonl") < cutoff {
			if errRemove := os.Remove(filepath.Join(s.dir, name)); errRemove != nil {
				log.Debugf("quota pool: prune history file %s: %v", name, errRemove)
			}
		}
	}
}

// read returns records with from <= t <= to grouped by credential ID, sorted by time.
func (s *historyStore) read(from, to time.Time) (map[string][]historyRecord, error) {
	out := make(map[string][]historyRecord)
	if s == nil || s.dir == "" || to.Before(from) {
		return out, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fromMs, toMs := from.UnixMilli(), to.UnixMilli()
	for day := from.UTC().Truncate(24 * time.Hour); !day.After(to.UTC()); day = day.Add(24 * time.Hour) {
		path := filepath.Join(s.dir, dayFileName(day))
		if errRead := readHistoryFile(path, func(record historyRecord) {
			if record.T >= fromMs && record.T <= toMs && record.ID != "" {
				out[record.ID] = append(out[record.ID], record)
			}
		}); errRead != nil {
			return nil, errRead
		}
	}
	for id := range out {
		records := out[id]
		sort.SliceStable(records, func(i, j int) bool { return records[i].T < records[j].T })
	}
	return out, nil
}

func readHistoryFile(path string, visit func(historyRecord)) (errOut error) {
	file, errOpen := os.Open(path)
	if errOpen != nil {
		if os.IsNotExist(errOpen) {
			return nil
		}
		return fmt.Errorf("open quota history file: %w", errOpen)
	}
	defer func() {
		if errClose := file.Close(); errClose != nil && errOut == nil {
			errOut = fmt.Errorf("close quota history file: %w", errClose)
		}
	}()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		var record historyRecord
		if errDecode := json.Unmarshal(scanner.Bytes(), &record); errDecode != nil {
			// A torn trailing line from a crash must not hide the rest of the history.
			continue
		}
		visit(record)
	}
	if errScan := scanner.Err(); errScan != nil {
		return fmt.Errorf("scan quota history file: %w", errScan)
	}
	return nil
}
