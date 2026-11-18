/**
 * Synthetic GET /quota/pools payloads (raw backend snake_case) for model and
 * rendering tests. No real credentials.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

interface FixtureAccount {
  id: string;
  provider: 'claude' | 'codex';
  email: string;
  plan: string;
  /** Weekly used percent at now. */
  used: number;
  /** Weekly reset relative to now. */
  resetInMs: number;
  /** Used percent added per hour of history. */
  burnPerHour: number;
}

const ACCOUNTS: FixtureAccount[] = [
  {
    id: 'claude-a.json',
    provider: 'claude',
    email: 'a@example.test',
    plan: 'max',
    used: 30,
    resetInMs: 16 * HOUR,
    burnPerHour: 0.4,
  },
  {
    id: 'claude-b.json',
    provider: 'claude',
    email: 'b@example.test',
    plan: 'max',
    used: 5,
    resetInMs: 3 * DAY,
    burnPerHour: 0.2,
  },
  {
    id: 'claude-c.json',
    provider: 'claude',
    email: '',
    plan: 'pro',
    used: 60,
    resetInMs: 5 * DAY,
    burnPerHour: 0.3,
  },
  {
    id: 'codex-a.json',
    provider: 'codex',
    email: 'c@example.test',
    plan: 'pro',
    used: 20,
    resetInMs: 6 * DAY,
    burnPerHour: 0.5,
  },
  {
    id: 'codex-b.json',
    provider: 'codex',
    email: 'd@example.test',
    plan: 'plus',
    used: 70,
    resetInMs: 2 * DAY,
    burnPerHour: 0.6,
  },
];

const windowIds = (provider: FixtureAccount['provider']) =>
  provider === 'claude' ? { short: '5h', long: '7d' } : { short: 'primary', long: 'secondary' };

/** Used percent at time t, walking back from now and undoing weekly resets. */
const usedAt = (account: FixtureAccount, now: number, t: number) => {
  const resetAt = now + account.resetInMs;
  const lastReset = resetAt - WEEK;
  if (t < lastReset) {
    // Previous period: it ended near 90% used.
    return Math.min(100, 90 - ((lastReset - t) / HOUR) * account.burnPerHour * 0.5);
  }
  return Math.max(0, account.used - ((now - t) / HOUR) * account.burnPerHour);
};

export function buildQuotaPoolsFixture(now: number, stepMs = 10 * MINUTE, days = 7) {
  const credentials = ACCOUNTS.map((account) => {
    const ids = windowIds(account.provider);
    return {
      id: account.id,
      auth_index: `idx-${account.id}`,
      name: account.id,
      provider: account.provider,
      email: account.email,
      label: account.email,
      plan: account.plan,
      disabled: false,
      observed_at: now - 2 * MINUTE,
      source: 'poll',
      error: '',
      windows: [
        { id: ids.short, used_percent: 12.5, reset_at: now + 2 * HOUR, period_seconds: 18000 },
        {
          id: ids.long,
          used_percent: account.used,
          reset_at: now + account.resetInMs,
          period_seconds: 604800,
        },
      ],
    };
  });

  credentials.push({
    id: 'codex-off.json',
    auth_index: 'idx-off',
    name: 'codex-off.json',
    provider: 'codex',
    email: 'off@example.test',
    label: '',
    plan: 'team',
    disabled: true,
    observed_at: now - HOUR,
    source: 'poll',
    error: '',
    windows: [{ id: 'secondary', used_percent: 10, reset_at: 0, period_seconds: 604800 }],
  });

  const history = ACCOUNTS.map((account) => {
    const ids = windowIds(account.provider);
    const points = [];
    for (let t = now - days * DAY; t < now - 2 * MINUTE; t += stepMs) {
      points.push({
        t,
        windows: [
          {
            id: ids.long,
            used_percent: Number(usedAt(account, now, t).toFixed(2)),
            reset_at: now + account.resetInMs - (t < now + account.resetInMs - WEEK ? WEEK : 0),
            period_seconds: 604800,
          },
        ],
      });
    }
    return { id: account.id, points };
  });

  return {
    now,
    strategy: 'soonest-reset',
    poll_interval_seconds: 600,
    credentials,
    history,
  };
}
