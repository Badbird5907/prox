/**
 * Pooled quota model: recorded pool series, burn rate, and a forward projection that
 * mirrors the backend's "soonest-reset" routing. React-free; consumed directly by
 * tests/quotaPoolModel.test.ts.
 *
 * Units: every "remaining" value is capacity-scaled percent, so an account with
 * capacity 2.5 contributes 0..250 to the pool.
 */

import type {
  QuotaPoolCredential,
  QuotaPoolHistoryPoint,
  QuotaPoolWindow,
} from '@/services/api/quotaPools';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Projection resolution. */
export const PROJECTION_STEP_MS = 5 * MINUTE_MS;
/** Resets closer than this are drawn as a single "+X%" label. */
export const RESET_MERGE_MS = HOUR_MS;
/** Recorded increases smaller than this are treated as noise, not resets. */
export const RECORDED_RESET_MIN_GAIN = 1;
/** Projection always looks at least this far ahead of now. */
export const MIN_PROJECTION_AHEAD_MS = 11 * DAY_MS;

const EPS = 1e-6;

export interface SeriesPoint {
  t: number;
  v: number;
}

export interface PoolAccount {
  id: string;
  /** Email, label or file name; the UI decides whether to blur it. */
  label: string;
  plan: string;
  capacity: number;
  windowId: string;
  periodMs: number;
  /** Current remaining, capacity-scaled. */
  remaining: number;
  resetAtMs: number | null;
  observedAtMs: number | null;
  /** Recorded remaining (capacity-scaled), ascending, including the current observation. */
  samples: SeriesPoint[];
  error: string;
}

export interface ResetEvent {
  t: number;
  accountId: string;
  gain: number;
}

export interface ResetLabel {
  /** First reset in the merged group. */
  t: number;
  /** Last reset in the merged group; labels sit above this step. */
  tEnd: number;
  gain: number;
  accountIds: string[];
}

export interface PoolProjection {
  pool: SeriesPoint[];
  accounts: Record<string, SeriesPoint[]>;
  resets: ResetEvent[];
  resetLabels: ResetLabel[];
  poolEmptyAt: number | null;
  firstEmpty: { accountId: string; t: number } | null;
}

export interface RecordedSeries {
  pool: SeriesPoint[];
  accounts: Record<string, SeriesPoint[]>;
}

/* ---------------------------------------------------------------- accounts */

/** The pool window is the longest window an account reports (Claude 7d, Codex weekly). */
export function selectPoolWindow(windows: QuotaPoolWindow[]): QuotaPoolWindow | null {
  let best: QuotaPoolWindow | null = null;
  for (const window of windows) {
    if (!best || window.periodSeconds > best.periodSeconds) best = window;
  }
  return best;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const remainingFromUsed = (usedPercent: number, capacity: number) =>
  clamp(100 - usedPercent, 0, 100) * capacity;

const pickHistoryWindow = (
  point: QuotaPoolHistoryPoint,
  windowId: string,
  periodSeconds: number
): QuotaPoolWindow | null =>
  point.windows.find((window) => window.id === windowId) ??
  (periodSeconds > 0
    ? (point.windows.find((window) => window.periodSeconds === periodSeconds) ?? null)
    : null);

export const accountDisplayLabel = (credential: QuotaPoolCredential) =>
  credential.email || credential.label || credential.name || credential.id;

/**
 * Build the accounts of one provider pool. Disabled credentials and credentials that
 * never reported a window are left out: the router cannot drain them.
 */
export function buildPoolAccounts(
  credentials: QuotaPoolCredential[],
  history: Record<string, QuotaPoolHistoryPoint[]>,
  provider: string,
  capacityFor: (provider: string, plan: string) => number,
  now: number
): PoolAccount[] {
  const accounts: PoolAccount[] = [];
  for (const credential of credentials) {
    if (credential.provider !== provider || credential.disabled) continue;
    const points = history[credential.id] ?? [];
    let window = selectPoolWindow(credential.windows);
    if (!window) {
      // Fall back to the newest recorded window so the account still shows its history.
      for (let i = points.length - 1; i >= 0 && !window; i -= 1) {
        window = selectPoolWindow(points[i].windows);
      }
    }
    if (!window) continue;

    const capacity = clamp(capacityFor(provider, credential.plan), 0, 100);
    const samples: SeriesPoint[] = [];
    for (const point of points) {
      const match = pickHistoryWindow(point, window.id, window.periodSeconds);
      if (!match) continue;
      samples.push({ t: point.t, v: remainingFromUsed(match.usedPercent, capacity) });
    }
    const remaining = remainingFromUsed(window.usedPercent, capacity);
    const observedAt = credential.observedAtMs ?? now;
    const last = samples[samples.length - 1];
    if (credential.windows.length > 0 && (!last || observedAt > last.t)) {
      samples.push({ t: observedAt, v: remaining });
    }

    accounts.push({
      id: credential.id,
      label: accountDisplayLabel(credential),
      plan: credential.plan,
      capacity,
      windowId: window.id,
      periodMs: window.periodSeconds * 1000,
      remaining,
      resetAtMs: window.resetAtMs,
      observedAtMs: credential.observedAtMs,
      samples,
      error: credential.error,
    });
  }
  return accounts;
}

/* ---------------------------------------------------------------- recorded */

/**
 * Step-carry each account's last known value across the union of sample times.
 * Before an account's first sample its first known value is used.
 */
export function buildRecordedSeries(
  accounts: PoolAccount[],
  from: number,
  to: number
): RecordedSeries {
  const times = new Set<number>();
  let hasEarlier = false;
  for (const account of accounts) {
    for (const sample of account.samples) {
      if (sample.t < from) hasEarlier = true;
      else if (sample.t <= to) times.add(sample.t);
    }
  }
  if (times.size === 0 && !hasEarlier) return { pool: [], accounts: {} };
  if (hasEarlier) times.add(from);
  times.add(to);
  const sorted = [...times].sort((a, b) => a - b);

  const pool: SeriesPoint[] = sorted.map((t) => ({ t, v: 0 }));
  const perAccount: Record<string, SeriesPoint[]> = {};
  for (const account of accounts) {
    if (account.samples.length === 0) continue;
    const series: SeriesPoint[] = [];
    let cursor = 0;
    sorted.forEach((t, index) => {
      while (cursor + 1 < account.samples.length && account.samples[cursor + 1].t <= t) {
        cursor += 1;
      }
      const v = account.samples[cursor].v;
      pool[index].v += v;
      series.push({ t, v });
    });
    perAccount[account.id] = simplifySeries(series);
  }
  return { pool: simplifySeries(pool), accounts: perAccount };
}

/** Increases between consecutive samples are resets; merged into labels. */
export function recordedResetLabels(
  accounts: PoolAccount[],
  mergeMs = RESET_MERGE_MS
): ResetLabel[] {
  const events: ResetEvent[] = [];
  for (const account of accounts) {
    for (let i = 1; i < account.samples.length; i += 1) {
      const gain = account.samples[i].v - account.samples[i - 1].v;
      if (gain >= RECORDED_RESET_MIN_GAIN) {
        events.push({ t: account.samples[i].t, accountId: account.id, gain });
      }
    }
  }
  return mergeResetEvents(events, mergeMs);
}

/* ---------------------------------------------------------------- burn */

export interface BurnIndex {
  times: number[];
  /** prefix[i] = total decrease of events 0..i-1. */
  prefix: number[];
  firstT: number | null;
}

/** Decreases between consecutive samples, attributed to the later sample's time. */
export function buildBurnIndex(accounts: PoolAccount[]): BurnIndex {
  const events: Array<{ t: number; amount: number }> = [];
  let firstT: number | null = null;
  for (const account of accounts) {
    const samples = account.samples;
    if (samples.length > 0 && (firstT === null || samples[0].t < firstT)) firstT = samples[0].t;
    for (let i = 1; i < samples.length; i += 1) {
      const drop = samples[i - 1].v - samples[i].v;
      if (drop > 0) events.push({ t: samples[i].t, amount: drop });
    }
  }
  events.sort((a, b) => a.t - b.t);
  const prefix = [0];
  events.forEach((event) => prefix.push(prefix[prefix.length - 1] + event.amount));
  return { times: events.map((event) => event.t), prefix, firstT };
}

/** Index of the first time strictly greater than t. */
const upperBound = (times: number[], t: number) => {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Pool burn in capacity-%/h over (t - windowMs, t], divided by the hours actually covered. */
export function burnRateAt(index: BurnIndex, t: number, windowMs: number): number {
  if (index.firstT === null || windowMs <= 0) return 0;
  const covered = Math.min(windowMs, t - index.firstT);
  if (covered < 5 * MINUTE_MS) return 0;
  const total =
    index.prefix[upperBound(index.times, t)] - index.prefix[upperBound(index.times, t - windowMs)];
  return total / (covered / HOUR_MS);
}

export function computeBurnRate(accounts: PoolAccount[], now: number, windowMs: number): number {
  return burnRateAt(buildBurnIndex(accounts), now, windowMs);
}

/** Recorded drain rate over time, smoothed over the burn window. */
export function buildDrainSeries(
  index: BurnIndex,
  from: number,
  to: number,
  windowMs: number,
  stepMs = 15 * MINUTE_MS
): SeriesPoint[] {
  if (index.firstT === null) return [];
  const start = Math.max(from, index.firstT);
  if (start >= to) return [];
  const points: SeriesPoint[] = [];
  for (let t = start; t < to; t += stepMs) {
    points.push({ t, v: burnRateAt(index, t, windowMs) });
  }
  points.push({ t: to, v: burnRateAt(index, to, windowMs) });
  return points;
}

/* ---------------------------------------------------------------- projection */

export function mergeResetEvents(events: ResetEvent[], mergeMs = RESET_MERGE_MS): ResetLabel[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const labels: ResetLabel[] = [];
  for (const event of sorted) {
    const current = labels[labels.length - 1];
    if (current && event.t - current.t < mergeMs) {
      current.gain += event.gain;
      current.tEnd = event.t;
      if (!current.accountIds.includes(event.accountId)) current.accountIds.push(event.accountId);
    } else {
      labels.push({ t: event.t, tEnd: event.t, gain: event.gain, accountIds: [event.accountId] });
    }
  }
  return labels;
}

/** Drop points that lie on the line between their neighbours; vertical steps are kept. */
export function simplifySeries(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length <= 2) return points;
  const out: SeriesPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const point = points[i];
    const next = points[i + 1];
    if (point.t === prev.t || point.t === next.t || next.t === prev.t) {
      out.push(point);
      continue;
    }
    const expected = prev.v + ((next.v - prev.v) * (point.t - prev.t)) / (next.t - prev.t);
    if (Math.abs(expected - point.v) > 1e-6) out.push(point);
  }
  out.push(points[points.length - 1]);
  return out;
}

export interface ProjectionOptions {
  now: number;
  end: number;
  /** Pool burn, capacity-%/h. */
  burnPerHour: number;
  /** Future usage multiplier (1 = same as now, 0 = idle). */
  multiplier: number;
  stepMs?: number;
}

interface SimAccount {
  id: string;
  cap: number;
  rem: number;
  next: number | null;
  period: number;
}

const rollForward = (next: number, period: number, after: number): number | null => {
  if (period <= 0) return null;
  const skips = Math.floor((after - next) / period) + 1;
  return next + skips * period;
};

/**
 * Simulate the pool forward. Consumption is routed to the non-empty account whose
 * reset comes soonest; an account returns to full capacity when its reset passes.
 */
export function projectPool(accounts: PoolAccount[], options: ProjectionOptions): PoolProjection {
  const { now, end } = options;
  const stepMs = options.stepMs ?? PROJECTION_STEP_MS;
  const ratePerMs = (Math.max(0, options.burnPerHour) * Math.max(0, options.multiplier)) / HOUR_MS;

  const sim: SimAccount[] = accounts.map((account) => {
    const cap = account.capacity * 100;
    let rem = clamp(account.remaining, 0, cap);
    let next = account.resetAtMs;
    // A reset that already passed means the latest observation is stale: the account is full.
    if (next !== null && next <= now) {
      rem = cap;
      next = rollForward(next, account.periodMs, now);
    }
    return { id: account.id, cap, rem, next, period: account.periodMs };
  });

  const pool: SeriesPoint[] = [];
  const perAccount: Record<string, SeriesPoint[]> = {};
  sim.forEach((account) => (perAccount[account.id] = []));
  const resets: ResetEvent[] = [];
  let poolEmptyAt: number | null = null;
  let firstEmpty: { accountId: string; t: number } | null = null;

  const total = () => sim.reduce((sum, account) => sum + account.rem, 0);
  const record = (t: number) => {
    pool.push({ t, v: total() });
    sim.forEach((account) => perAccount[account.id].push({ t, v: account.rem }));
  };

  record(now);
  for (const account of sim) {
    if (account.cap > 0 && account.rem <= EPS && !firstEmpty) {
      firstEmpty = { accountId: account.id, t: now };
    }
  }
  if (sim.length > 0 && total() <= EPS) poolEmptyAt = now;

  const consume = (from: number, to: number) => {
    if (ratePerMs <= 0 || to <= from) return;
    let need = ratePerMs * (to - from);
    let consumed = 0;
    const order = sim
      .filter((account) => account.rem > EPS)
      .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || a.id.localeCompare(b.id));
    for (const account of order) {
      if (need <= EPS) break;
      const take = Math.min(account.rem, need);
      account.rem -= take;
      need -= take;
      consumed += take;
      if (account.rem <= EPS) {
        account.rem = 0;
        if (!firstEmpty) firstEmpty = { accountId: account.id, t: from + consumed / ratePerMs };
      }
    }
    if (need > EPS && poolEmptyAt === null && sim.length > 0) {
      poolEmptyAt = from + consumed / ratePerMs;
    }
  };

  let t = now;
  while (t < end) {
    const t1 = Math.min(t + stepMs, end);
    let cursor = t;
    for (;;) {
      let nextReset: number | null = null;
      for (const account of sim) {
        if (account.next !== null && account.next <= t1) {
          nextReset = nextReset === null ? account.next : Math.min(nextReset, account.next);
        }
      }
      consume(cursor, nextReset ?? t1);
      if (nextReset === null) break;
      cursor = nextReset;
      record(cursor);
      for (const account of sim) {
        if (account.next === null || account.next > cursor) continue;
        const gain = account.cap - account.rem;
        if (gain > EPS) resets.push({ t: cursor, accountId: account.id, gain });
        account.rem = account.cap;
        account.next = rollForward(account.next, account.period, cursor);
      }
      record(cursor);
    }
    record(t1);
    t = t1;
  }

  Object.keys(perAccount).forEach((id) => (perAccount[id] = simplifySeries(perAccount[id])));
  return {
    pool: simplifySeries(pool),
    accounts: perAccount,
    resets,
    resetLabels: mergeResetEvents(resets),
    poolEmptyAt,
    firstEmpty,
  };
}

/* ---------------------------------------------------------------- facade */

export interface PoolModelOptions {
  now: number;
  spanStart: number;
  spanEnd: number;
  burnWindowMs: number;
  multiplier: number;
}

export interface PoolModel {
  accounts: PoolAccount[];
  capacityTotal: number;
  /** Pool remaining at now, after applying resets that already passed. */
  remainingNow: number;
  burnPerHour: number;
  horizonEnd: number;
  recorded: RecordedSeries;
  recordedResets: ResetLabel[];
  projection: PoolProjection;
  drainRecorded: SeriesPoint[];
}

export function buildPoolModel(accounts: PoolAccount[], options: PoolModelOptions): PoolModel {
  const { now, spanStart, spanEnd, burnWindowMs, multiplier } = options;
  const index = buildBurnIndex(accounts);
  const burnPerHour = burnRateAt(index, now, burnWindowMs);
  const horizonEnd = Math.max(spanEnd, now + MIN_PROJECTION_AHEAD_MS);
  const recordedFrom = Math.min(spanStart, index.firstT ?? spanStart);
  const projection = projectPool(accounts, { now, end: horizonEnd, burnPerHour, multiplier });
  return {
    accounts,
    capacityTotal: accounts.reduce((sum, account) => sum + account.capacity * 100, 0),
    remainingNow: projection.pool[0]?.v ?? 0,
    burnPerHour,
    horizonEnd,
    recorded: buildRecordedSeries(accounts, recordedFrom, now),
    recordedResets: recordedResetLabels(accounts),
    projection,
    drainRecorded: buildDrainSeries(index, Math.max(spanStart, recordedFrom), now, burnWindowMs),
  };
}

/** Linear interpolation; outside the series returns null. */
export function valueAt(series: SeriesPoint[], t: number): number | null {
  if (series.length === 0 || t < series[0].t || t > series[series.length - 1].t) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t === a.t) return b.v;
  if (t >= b.t) return b.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/* ---------------------------------------------------------------- span */

export const SPAN_BEFORE_MS = 3 * DAY_MS;
export const SPAN_AFTER_MS = 11 * DAY_MS;
export const SPAN_SHIFT_MS = 7 * DAY_MS;

/** Visible 14-day span: now-3d..now+11d, shifted by whole weeks. */
export function poolSpan(now: number, offsetWeeks: number): { start: number; end: number } {
  const anchor = now + offsetWeeks * SPAN_SHIFT_MS;
  return { start: anchor - SPAN_BEFORE_MS, end: anchor + SPAN_AFTER_MS };
}

const POOL_PROVIDER_ORDER = ['claude', 'codex'];

/** Providers with at least one enabled credential reporting windows, Claude and Codex first. */
export function orderPoolProviders(credentials: QuotaPoolCredential[]): string[] {
  const providers = new Set<string>();
  for (const credential of credentials) {
    if (!credential.disabled && credential.provider && credential.windows.length > 0) {
      providers.add(credential.provider);
    }
  }
  return [...providers].sort((a, b) => {
    const rank = (provider: string) => {
      const index = POOL_PROVIDER_ORDER.indexOf(provider);
      return index === -1 ? POOL_PROVIDER_ORDER.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}
