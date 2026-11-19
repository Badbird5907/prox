import { describe, expect, test } from 'bun:test';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  buildBurnIndex,
  buildPoolAccounts,
  buildPoolModel,
  buildRecordedSeries,
  burnRateAt,
  computeBurnRate,
  mergeResetEvents,
  projectPool,
  recordedResetLabels,
  selectPoolWindow,
  valueAt,
  type PoolAccount,
} from '../src/features/quota/pool/poolModel';
import {
  normalizeQuotaPoolsRefresh,
  normalizeQuotaPoolsResponse,
} from '../src/services/api/quotaPools';
import { formatPoolDuration, formatBurn, niceCeil } from '../src/features/quota/pool/poolFormat';
import {
  parsePoolPrefs,
  planDisplayName,
  readPoolPrefs,
  resolvePlanCapacity,
  writePoolPrefs,
} from '../src/features/quota/pool/poolPrefs';
import { buildQuotaPoolsFixture } from './fixtures/quotaPools';

const NOW = Date.UTC(2026, 10, 18, 12);

const account = (overrides: Partial<PoolAccount> & { id: string }): PoolAccount => ({
  label: overrides.id,
  plan: '',
  capacity: 1,
  windowId: '7d',
  periodMs: 7 * DAY_MS,
  remaining: 100,
  resetAtMs: null,
  observedAtMs: NOW,
  samples: [],
  error: '',
  ...overrides,
});

describe('quota pools API normalization', () => {
  test('normalizes credentials, history and unknown reset times', () => {
    const snapshot = normalizeQuotaPoolsResponse(buildQuotaPoolsFixture(NOW));
    expect(snapshot.now).toBe(NOW);
    expect(snapshot.strategy).toBe('soonest-reset');
    expect(snapshot.pollIntervalSeconds).toBe(600);
    expect(snapshot.credentials).toHaveLength(6);
    const off = snapshot.credentials.find((credential) => credential.id === 'codex-off.json');
    expect(off?.disabled).toBe(true);
    expect(off?.windows[0].resetAtMs).toBeNull();
    const history = snapshot.history['claude-a.json'];
    expect(history.length).toBeGreaterThan(900);
    expect(history[0].t).toBeLessThan(history[1].t);
    expect(history[0].windows[0].periodSeconds).toBe(604800);
  });

  test('tolerates garbage and null observed_at', () => {
    const snapshot = normalizeQuotaPoolsResponse(
      {
        credentials: [
          { id: 'x', provider: 'Claude', observed_at: null, windows: [{ id: '7d' }, 'bad'] },
          { provider: 'claude' },
        ],
        history: [{ id: 'x', points: [{ t: 0 }, { t: 5, windows: null }] }],
      },
      42
    );
    expect(snapshot.now).toBe(42);
    expect(snapshot.credentials).toHaveLength(1);
    expect(snapshot.credentials[0].provider).toBe('claude');
    expect(snapshot.credentials[0].observedAtMs).toBeNull();
    expect(snapshot.credentials[0].windows).toEqual([]);
    expect(snapshot.history.x).toEqual([{ t: 5, windows: [] }]);
  });

  test('normalizes refresh results', () => {
    expect(normalizeQuotaPoolsRefresh({ refreshed: 3, errors: { a: 'boom', b: '' } })).toEqual({
      refreshed: 3,
      errors: { a: 'boom' },
    });
    expect(normalizeQuotaPoolsRefresh(null)).toEqual({ refreshed: 0, errors: {} });
  });
});

describe('pool accounts', () => {
  test('uses the longest window and scales by plan capacity', () => {
    const snapshot = normalizeQuotaPoolsResponse(buildQuotaPoolsFixture(NOW));
    expect(selectPoolWindow(snapshot.credentials[0].windows)?.id).toBe('7d');
    const codex = buildPoolAccounts(
      snapshot.credentials,
      snapshot.history,
      'codex',
      (provider, plan) => resolvePlanCapacity({}, provider, plan),
      NOW
    );
    // Disabled credentials are not part of the pool.
    expect(codex.map((item) => item.id)).toEqual(['codex-a.json', 'codex-b.json']);
    expect(codex[0].windowId).toBe('secondary');
    expect(codex[0].capacity).toBe(2.5);
    expect(codex[0].remaining).toBe(200);
    expect(codex[1].remaining).toBe(30);
    // The current observation is appended after the recorded history.
    const last = codex[0].samples[codex[0].samples.length - 1];
    expect(last).toEqual({ t: NOW - 2 * MINUTE_MS, v: 200 });
  });
});

describe('burn rate', () => {
  test('sums decreases over the window and ignores reset increases', () => {
    const samples = [];
    // 1% every 10 minutes (6%/h) for 3 hours, with a reset jump in the middle.
    let v = 80;
    for (let t = NOW - 3 * HOUR_MS; t <= NOW; t += 10 * MINUTE_MS) {
      samples.push({ t, v });
      v -= 1;
      if (t === NOW - 90 * MINUTE_MS) v = 100;
    }
    const accounts = [account({ id: 'a', samples })];
    // 18 intervals, one of which is the reset: 17 one-point decreases over 3h.
    expect(computeBurnRate(accounts, NOW, 3 * HOUR_MS)).toBeCloseTo(17 / 3, 5);
    expect(computeBurnRate(accounts, NOW, HOUR_MS)).toBeCloseTo(6, 5);
  });

  test('scales by capacity and divides by the hours actually covered', () => {
    const accounts = [
      account({
        id: 'big',
        capacity: 2.5,
        samples: [
          { t: NOW - HOUR_MS, v: 250 },
          { t: NOW, v: 240 },
        ],
      }),
      account({
        id: 'small',
        samples: [
          { t: NOW - 30 * MINUTE_MS, v: 50 },
          { t: NOW, v: 45 },
        ],
      }),
    ];
    // Only one hour of history exists, so a 3h window divides by 1h.
    expect(computeBurnRate(accounts, NOW, 3 * HOUR_MS)).toBeCloseTo(15, 5);
    const index = buildBurnIndex(accounts);
    expect(burnRateAt(index, NOW - 2 * HOUR_MS, HOUR_MS)).toBe(0);
  });
});

describe('projection', () => {
  test('drains the account with the soonest reset first', () => {
    const accounts = [
      account({ id: 'late', remaining: 50, resetAtMs: NOW + 3 * DAY_MS }),
      account({ id: 'soon', remaining: 50, resetAtMs: NOW + DAY_MS }),
    ];
    const projection = projectPool(accounts, {
      now: NOW,
      end: NOW + 4 * HOUR_MS,
      burnPerHour: 10,
      multiplier: 1,
    });
    expect(valueAt(projection.accounts.soon, NOW + 2 * HOUR_MS)).toBeCloseTo(30, 5);
    expect(valueAt(projection.accounts.late, NOW + 2 * HOUR_MS)).toBeCloseTo(50, 5);
    expect(valueAt(projection.pool, NOW + 4 * HOUR_MS)).toBeCloseTo(60, 5);
  });

  test('records reset gains and merges nearby resets into one label', () => {
    const accounts = [
      account({ id: 'a', remaining: 40, resetAtMs: NOW + 2 * HOUR_MS }),
      account({ id: 'b', remaining: 70, resetAtMs: NOW + 2 * HOUR_MS + 30 * MINUTE_MS }),
      account({ id: 'c', remaining: 90, resetAtMs: NOW + 6 * HOUR_MS }),
    ];
    const projection = projectPool(accounts, {
      now: NOW,
      end: NOW + 8 * HOUR_MS,
      burnPerHour: 0,
      multiplier: 1,
    });
    expect(projection.resets.map((reset) => [reset.accountId, reset.gain])).toEqual([
      ['a', 60],
      ['b', 30],
      ['c', 10],
    ]);
    expect(projection.resetLabels).toHaveLength(2);
    expect(projection.resetLabels[0]).toMatchObject({
      t: NOW + 2 * HOUR_MS,
      tEnd: NOW + 2 * HOUR_MS + 30 * MINUTE_MS,
      gain: 90,
    });
    // Vertical step: the pool jumps at the reset instant.
    expect(valueAt(projection.pool, NOW + 3 * HOUR_MS)).toBeCloseTo(290, 5);
    // Weekly resets recur one period later.
    expect(accounts[0].resetAtMs).toBe(NOW + 2 * HOUR_MS);
  });

  test('treats a reset that already passed as a full account', () => {
    const projection = projectPool(
      [account({ id: 'a', remaining: 10, resetAtMs: NOW - HOUR_MS, periodMs: DAY_MS })],
      { now: NOW, end: NOW + 2 * DAY_MS, burnPerHour: 0, multiplier: 1 }
    );
    expect(projection.pool[0].v).toBe(100);
    // Next reset rolls forward by one period and gains nothing (still full).
    expect(projection.resets).toEqual([]);
  });

  test('detects first account empty and pool empty times', () => {
    const accounts = [
      account({ id: 'a', remaining: 10, resetAtMs: NOW + 5 * DAY_MS }),
      account({ id: 'b', remaining: 10, resetAtMs: NOW + 4 * DAY_MS }),
    ];
    const projection = projectPool(accounts, {
      now: NOW,
      end: NOW + DAY_MS,
      burnPerHour: 10,
      multiplier: 1,
    });
    expect(projection.firstEmpty?.accountId).toBe('b');
    expect(projection.firstEmpty?.t).toBeCloseTo(NOW + HOUR_MS, -1);
    expect(projection.poolEmptyAt).toBeCloseTo(NOW + 2 * HOUR_MS, -1);
    expect(valueAt(projection.pool, NOW + 3 * HOUR_MS)).toBe(0);
  });

  test('future multiplier scales consumption and idle never empties', () => {
    const accounts = [account({ id: 'a', remaining: 10 })];
    const heavy = projectPool(accounts, {
      now: NOW,
      end: NOW + DAY_MS,
      burnPerHour: 10,
      multiplier: 1.5,
    });
    expect(heavy.poolEmptyAt).toBeCloseTo(NOW + 40 * MINUTE_MS, -1);
    const idle = projectPool(accounts, {
      now: NOW,
      end: NOW + DAY_MS,
      burnPerHour: 10,
      multiplier: 0,
    });
    expect(idle.poolEmptyAt).toBeNull();
    expect(idle.firstEmpty).toBeNull();
  });

  test('merges events by first timestamp in a group', () => {
    const labels = mergeResetEvents([
      { t: 3 * HOUR_MS, accountId: 'c', gain: 5 },
      { t: 0, accountId: 'a', gain: 10 },
      { t: 59 * MINUTE_MS, accountId: 'b', gain: 20 },
    ]);
    expect(labels.map((label) => label.gain)).toEqual([30, 5]);
  });
});

describe('recorded series', () => {
  test('step-carries last values and backfills with the first known value', () => {
    const accounts = [
      account({
        id: 'a',
        samples: [
          { t: NOW - 3 * HOUR_MS, v: 90 },
          { t: NOW - HOUR_MS, v: 80 },
        ],
      }),
      account({
        id: 'b',
        capacity: 2,
        samples: [
          { t: NOW - 2 * HOUR_MS, v: 150 },
          { t: NOW - 30 * MINUTE_MS, v: 200 },
        ],
      }),
    ];
    const recorded = buildRecordedSeries(accounts, NOW - 6 * HOUR_MS, NOW);
    const at = (t: number) => recorded.pool.find((point) => point.t === t)?.v;
    expect(at(NOW - 3 * HOUR_MS)).toBe(240);
    expect(at(NOW - 2 * HOUR_MS)).toBe(240);
    expect(at(NOW - HOUR_MS)).toBe(230);
    expect(at(NOW - 30 * MINUTE_MS)).toBe(280);
    expect(at(NOW)).toBe(280);
    expect(recordedResetLabels(accounts)).toEqual([
      { t: NOW - 30 * MINUTE_MS, tEnd: NOW - 30 * MINUTE_MS, gain: 50, accountIds: ['b'] },
    ]);
  });

  test('builds a full pool model from the fixture', () => {
    const snapshot = normalizeQuotaPoolsResponse(buildQuotaPoolsFixture(NOW));
    const accounts = buildPoolAccounts(
      snapshot.credentials,
      snapshot.history,
      'claude',
      () => 1,
      NOW
    );
    const model = buildPoolModel(accounts, {
      now: NOW,
      spanStart: NOW - 3 * DAY_MS,
      spanEnd: NOW + 11 * DAY_MS,
      burnWindowMs: 3 * HOUR_MS,
      multiplier: 1,
    });
    expect(model.capacityTotal).toBe(300);
    expect(model.remainingNow).toBeCloseTo(70 + 95 + 40, 5);
    // Fixture burns 0.4 + 0.2 + 0.3 used-%/h.
    expect(model.burnPerHour).toBeGreaterThan(0.7);
    expect(model.burnPerHour).toBeLessThan(1.1);
    expect(model.recorded.pool.length).toBeGreaterThan(2);
    expect(model.recordedResets.length).toBeGreaterThan(0);
    expect(model.projection.resetLabels[0].t).toBe(NOW + 16 * HOUR_MS);
    expect(model.drainRecorded.length).toBeGreaterThan(10);
    expect(model.horizonEnd).toBe(NOW + 11 * DAY_MS);
  });
});

describe('pool formatting and prefs', () => {
  test('formats durations and burn', () => {
    expect(formatPoolDuration(15 * HOUR_MS + 49 * MINUTE_MS)).toBe('15h 49m');
    expect(formatPoolDuration(2 * DAY_MS + 18 * HOUR_MS + 5 * MINUTE_MS)).toBe('2d 18h');
    expect(formatPoolDuration(30 * 1000)).toBe('<1m');
    expect(formatBurn(3.74)).toBe('3.7%/h');
    expect(formatBurn(12.4)).toBe('12%/h');
    expect(niceCeil(13.2)).toBe(15);
  });

  test('parses prefs defensively and round-trips through storage', () => {
    expect(parsePoolPrefs({ mode: 'x', burnHours: 2, capacities: { 'codex:pro': -1 } })).toEqual({
      mode: 'remaining',
      burnHours: 3,
      future: 'same',
      showAccounts: false,
      showEmails: false,
      capacities: {},
    });
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;
    const prefs = { ...readPoolPrefs(storage), future: 'idle' as const, showEmails: true };
    writePoolPrefs(prefs, storage);
    expect(readPoolPrefs(storage)).toEqual(prefs);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readPoolPrefs(throwing).mode).toBe('remaining');
    expect(() => writePoolPrefs(prefs, throwing)).not.toThrow();
  });

  test('resolves default plan capacities and names', () => {
    expect(resolvePlanCapacity({}, 'codex', 'pro')).toBe(2.5);
    expect(resolvePlanCapacity({ 'codex:pro': 3 }, 'codex', 'pro')).toBe(3);
    expect(resolvePlanCapacity({}, 'claude', 'max')).toBe(1);
    expect(planDisplayName('codex', 'pro')).toBe('Pro Max');
    expect(planDisplayName('claude', 'max')).toBe('Max');
    expect(planDisplayName('claude', '')).toBe('');
  });
});
