/**
 * Pooled quota view preferences, persisted per browser in localStorage.
 * Every access is guarded: storage may be missing or throw (private mode, SSR).
 */

export type PoolChartMode = 'remaining' | 'drain';
export type FutureUsageId = 'same' | 'heavier' | 'lighter' | 'idle';

export const POOL_CHART_MODES: readonly PoolChartMode[] = ['remaining', 'drain'];
export const POOL_BURN_WINDOWS_HOURS: readonly number[] = [1, 3, 6];
export const POOL_FUTURE_USAGE: Record<FutureUsageId, number> = {
  same: 1,
  heavier: 1.5,
  lighter: 0.5,
  idle: 0,
};
export const POOL_FUTURE_USAGE_IDS = Object.keys(POOL_FUTURE_USAGE) as FutureUsageId[];

/** Default capacity overrides keyed by `provider:plan`; everything else is 1. */
export const DEFAULT_PLAN_CAPACITIES: Readonly<Record<string, number>> = {
  'codex:pro': 2.5,
};

/** Display names for plans whose upstream id reads poorly. */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  'codex:pro': 'Pro Max',
  'codex:prolite': 'Pro Lite',
};

export interface PoolPrefs {
  mode: PoolChartMode;
  burnHours: number;
  future: FutureUsageId;
  showAccounts: boolean;
  showEmails: boolean;
  capacities: Record<string, number>;
}

export const DEFAULT_POOL_PREFS: PoolPrefs = {
  mode: 'remaining',
  burnHours: 3,
  future: 'same',
  showAccounts: false,
  showEmails: false,
  capacities: {},
};

const POOL_PREFS_KEY = 'quotaPools.prefs';

const getStorage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const capacityKey = (provider: string, plan: string) => `${provider}:${plan}`;

export const isValidCapacity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

export function parsePoolPrefs(raw: unknown): PoolPrefs {
  const record =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const capacities: Record<string, number> = {};
  const rawCapacities = record.capacities;
  if (rawCapacities && typeof rawCapacities === 'object' && !Array.isArray(rawCapacities)) {
    Object.entries(rawCapacities as Record<string, unknown>).forEach(([key, value]) => {
      if (isValidCapacity(value)) capacities[key] = value;
    });
  }
  return {
    mode: POOL_CHART_MODES.includes(record.mode as PoolChartMode)
      ? (record.mode as PoolChartMode)
      : DEFAULT_POOL_PREFS.mode,
    burnHours: POOL_BURN_WINDOWS_HOURS.includes(record.burnHours as number)
      ? (record.burnHours as number)
      : DEFAULT_POOL_PREFS.burnHours,
    future: POOL_FUTURE_USAGE_IDS.includes(record.future as FutureUsageId)
      ? (record.future as FutureUsageId)
      : DEFAULT_POOL_PREFS.future,
    showAccounts: record.showAccounts === true,
    showEmails: record.showEmails === true,
    capacities,
  };
}

export function readPoolPrefs(storage: Storage | null = getStorage()): PoolPrefs {
  if (!storage) return { ...DEFAULT_POOL_PREFS };
  try {
    const raw = storage.getItem(POOL_PREFS_KEY);
    return raw ? parsePoolPrefs(JSON.parse(raw)) : { ...DEFAULT_POOL_PREFS };
  } catch {
    return { ...DEFAULT_POOL_PREFS };
  }
}

export function writePoolPrefs(prefs: PoolPrefs, storage: Storage | null = getStorage()) {
  if (!storage) return;
  try {
    storage.setItem(POOL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Persistence is a convenience; ignore quota and privacy-mode failures.
  }
}

export function resolvePlanCapacity(
  capacities: Record<string, number>,
  provider: string,
  plan: string
): number {
  const key = capacityKey(provider, plan);
  if (isValidCapacity(capacities[key])) return capacities[key];
  return DEFAULT_PLAN_CAPACITIES[key] ?? 1;
}

/** Human plan name; empty when the backend did not report a plan. */
export function planDisplayName(provider: string, plan: string): string {
  if (!plan) return '';
  const known = PLAN_LABELS[capacityKey(provider, plan)];
  if (known) return known;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
