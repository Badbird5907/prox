/**
 * Pooled quota API: per-credential quota windows plus recorded history, served by
 * GET /quota/pools. Raw backend field names stay in this module.
 */

import { apiClient } from './client';

export interface QuotaPoolWindow {
  id: string;
  usedPercent: number;
  /** Unix ms, or null when the backend does not know the reset time. */
  resetAtMs: number | null;
  periodSeconds: number;
}

export interface QuotaPoolCredential {
  id: string;
  authIndex: string;
  name: string;
  provider: string;
  email: string;
  label: string;
  plan: string;
  disabled: boolean;
  observedAtMs: number | null;
  source: string;
  error: string;
  windows: QuotaPoolWindow[];
}

export interface QuotaPoolHistoryPoint {
  t: number;
  windows: QuotaPoolWindow[];
}

export interface QuotaPoolsSnapshot {
  now: number;
  strategy: string;
  pollIntervalSeconds: number;
  credentials: QuotaPoolCredential[];
  /** Points per credential id, sorted by time ascending. */
  history: Record<string, QuotaPoolHistoryPoint[]>;
}

export interface QuotaPoolsRefreshResult {
  refreshed: number;
  errors: Record<string, string>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Positive unix ms; zero, negatives and garbage mean "unknown". */
const readInstant = (value: unknown): number | null => {
  const parsed = readNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

export function normalizeQuotaPoolWindow(value: unknown): QuotaPoolWindow | null {
  const raw = asRecord(value);
  const id = readString(raw.id);
  const used = readNumber(raw.used_percent);
  if (!id || used === null) return null;
  const period = readNumber(raw.period_seconds);
  return {
    id,
    usedPercent: Math.min(100, Math.max(0, used)),
    resetAtMs: readInstant(raw.reset_at),
    periodSeconds: period !== null && period > 0 ? period : 0,
  };
}

const normalizeWindows = (value: unknown): QuotaPoolWindow[] =>
  asArray(value)
    .map(normalizeQuotaPoolWindow)
    .filter((window): window is QuotaPoolWindow => window !== null);

export function normalizeQuotaPoolCredential(value: unknown): QuotaPoolCredential | null {
  const raw = asRecord(value);
  const id = readString(raw.id) || readString(raw.name);
  if (!id) return null;
  return {
    id,
    authIndex: readString(raw.auth_index),
    name: readString(raw.name) || id,
    provider: readString(raw.provider).toLowerCase(),
    email: readString(raw.email),
    label: readString(raw.label),
    plan: readString(raw.plan).toLowerCase(),
    disabled: raw.disabled === true,
    observedAtMs: readInstant(raw.observed_at),
    source: readString(raw.source),
    error: readString(raw.error),
    windows: normalizeWindows(raw.windows),
  };
}

export function normalizeQuotaPoolsResponse(
  payload: unknown,
  fallbackNow = Date.now()
): QuotaPoolsSnapshot {
  const raw = asRecord(payload);
  const credentials = asArray(raw.credentials)
    .map(normalizeQuotaPoolCredential)
    .filter((credential): credential is QuotaPoolCredential => credential !== null);

  const history: Record<string, QuotaPoolHistoryPoint[]> = {};
  asArray(raw.history).forEach((entry) => {
    const record = asRecord(entry);
    const id = readString(record.id);
    if (!id) return;
    const points = asArray(record.points)
      .map((point): QuotaPoolHistoryPoint | null => {
        const rawPoint = asRecord(point);
        const t = readInstant(rawPoint.t);
        if (t === null) return null;
        return { t, windows: normalizeWindows(rawPoint.windows) };
      })
      .filter((point): point is QuotaPoolHistoryPoint => point !== null);
    history[id] = [...(history[id] ?? []), ...points].sort((a, b) => a.t - b.t);
  });

  const poll = readNumber(raw.poll_interval_seconds);
  return {
    now: readInstant(raw.now) ?? fallbackNow,
    strategy: readString(raw.strategy),
    pollIntervalSeconds: poll !== null && poll > 0 ? poll : 0,
    credentials,
    history,
  };
}

export function normalizeQuotaPoolsRefresh(payload: unknown): QuotaPoolsRefreshResult {
  const raw = asRecord(payload);
  const errors: Record<string, string> = {};
  Object.entries(asRecord(raw.errors)).forEach(([id, message]) => {
    const text = readString(message);
    if (text) errors[id] = text;
  });
  const refreshed = readNumber(raw.refreshed);
  return { refreshed: refreshed !== null && refreshed > 0 ? refreshed : 0, errors };
}

export const QUOTA_POOLS_PATH = '/quota/pools';
export const QUOTA_POOLS_REFRESH_PATH = '/quota/pools/refresh';

export const quotaPoolsApi = {
  async get(range?: { from?: number; to?: number }): Promise<QuotaPoolsSnapshot> {
    const params: Record<string, number> = {};
    if (range?.from !== undefined) params.from = Math.round(range.from);
    if (range?.to !== undefined) params.to = Math.round(range.to);
    const data = await apiClient.get<unknown>(QUOTA_POOLS_PATH, { params });
    return normalizeQuotaPoolsResponse(data);
  },

  async refresh(): Promise<QuotaPoolsRefreshResult> {
    const data = await apiClient.post<unknown>(QUOTA_POOLS_REFRESH_PATH, {});
    return normalizeQuotaPoolsRefresh(data);
  },
};
