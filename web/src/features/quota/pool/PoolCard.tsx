import { useTranslation } from 'react-i18next';
import { getAuthFileIcon, getTypeLabel, type ResolvedTheme } from '@/features/authFiles/constants';
import { PoolChart } from './PoolChart';
import type { PoolModel } from './poolModel';
import {
  formatBurn,
  formatCapacity,
  formatMonthDay,
  formatPoolDuration,
  formatPoolPercent,
  formatSignedPercent,
  formatWeekdayTime,
} from './poolFormat';
import {
  capacityKey,
  isValidCapacity,
  planDisplayName,
  resolvePlanCapacity,
  type PoolChartMode,
} from './poolPrefs';
import styles from './PoolCard.module.scss';

/** Provider series colors; unknown providers fall back to a neutral indigo. */
const POOL_PROVIDER_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#6f8ef6',
};
const FALLBACK_COLOR = '#8b8cf6';

export interface PoolCardProps {
  provider: string;
  model: PoolModel;
  mode: PoolChartMode;
  multiplier: number;
  burnHours: number;
  now: number;
  spanStart: number;
  spanEnd: number;
  locale: string;
  resolvedTheme: ResolvedTheme;
  showAccounts: boolean;
  showEmails: boolean;
  capacities: Record<string, number>;
  onCapacityChange: (provider: string, plan: string, capacity: number) => void;
  chartWidth?: number;
}

export function PoolCard({
  provider,
  model,
  mode,
  multiplier,
  burnHours,
  now,
  spanStart,
  spanEnd,
  locale,
  resolvedTheme,
  showAccounts,
  showEmails,
  capacities,
  onCapacityChange,
  chartWidth,
}: PoolCardProps) {
  const { t } = useTranslation();
  const color = POOL_PROVIDER_COLORS[provider] ?? FALLBACK_COLOR;
  const providerName = getTypeLabel(t, provider);
  const icon = getAuthFileIcon(provider, resolvedTheme);
  const sensitive = showEmails ? styles.sensitiveShown : styles.sensitive;
  const labelOf = (id: string) => model.accounts.find((account) => account.id === id)?.label ?? id;

  const plans = [...new Set(model.accounts.map((account) => account.plan))].sort();
  const capacityNotes = plans
    .map((plan) => ({ plan, capacity: resolvePlanCapacity(capacities, provider, plan) }))
    .filter(({ capacity }) => capacity !== 1)
    .map(({ plan, capacity }) =>
      t('quota_pools.capacity_note', {
        plan: planDisplayName(provider, plan) || t('quota_pools.plan_unknown'),
        capacity: formatCapacity(capacity),
      })
    );

  const { projection } = model;
  const nextResetOf = (resetAtMs: number | null, periodMs: number): number | null => {
    if (resetAtMs === null) return null;
    if (resetAtMs > now) return resetAtMs;
    if (periodMs <= 0) return null;
    return resetAtMs + (Math.floor((now - resetAtMs) / periodMs) + 1) * periodMs;
  };
  const poolNextReset = projection.resetLabels[0] ?? null;
  const firstEmpty = projection.firstEmpty;

  return (
    <article className={styles.card} aria-label={providerName}>
      <header className={styles.head}>
        <span className={styles.iconWrap} aria-hidden="true">
          {icon ? <img src={icon} alt="" className={styles.icon} /> : providerName.slice(0, 1)}
        </span>
        <h2 className={styles.name}>{providerName}</h2>
        <span className={styles.count}>
          {t('quota_pools.accounts_count', { count: model.accounts.length })}
        </span>
      </header>

      <div className={styles.summary}>
        <div className={styles.headline}>
          <span className={styles.bigNumber}>{formatPoolPercent(model.remainingNow)}</span>
          <span className={styles.ofTotal}>
            {t('quota_pools.of_capacity', { total: formatPoolPercent(model.capacityTotal) })}
          </span>
          {capacityNotes.map((note) => (
            <span key={note} className={styles.ofTotal}>
              {note}
            </span>
          ))}
        </div>

        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt>{t('quota_pools.stat_pool_empty')}</dt>
            <dd>
              {projection.poolEmptyAt !== null
                ? projection.poolEmptyAt <= now
                  ? t('quota_pools.empty_now')
                  : formatWeekdayTime(projection.poolEmptyAt, locale)
                : t('quota_pools.not_by', { date: formatMonthDay(model.horizonEnd, locale) })}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('quota_pools.stat_first_empty')}</dt>
            <dd>
              {firstEmpty ? (
                <>
                  <span className={sensitive}>{labelOf(firstEmpty.accountId)}</span>{' '}
                  {firstEmpty.t <= now
                    ? t('quota_pools.empty_now')
                    : t('quota_pools.in_duration', {
                        duration: formatPoolDuration(firstEmpty.t - now),
                      })}
                </>
              ) : (
                t('quota_pools.none')
              )}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('quota_pools.stat_next_reset')}</dt>
            <dd>
              {poolNextReset ? (
                <>
                  <strong>{formatSignedPercent(poolNextReset.gain)}</strong>{' '}
                  {formatWeekdayTime(poolNextReset.t, locale)}
                </>
              ) : (
                t('quota_pools.none')
              )}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('quota_pools.stat_burn', { hours: burnHours })}</dt>
            <dd>{formatBurn(model.burnPerHour)}</dd>
          </div>
        </dl>
      </div>

      <PoolChart
        model={model}
        mode={mode}
        multiplier={multiplier}
        now={now}
        spanStart={spanStart}
        spanEnd={spanEnd}
        color={color}
        showAccounts={showAccounts}
        locale={locale}
        initialWidth={chartWidth}
        ariaLabel={t('quota_pools.chart_label', {
          provider: providerName,
          mode: t(mode === 'remaining' ? 'quota_pools.mode_remaining' : 'quota_pools.mode_drain'),
        })}
      />

      <div className={styles.legend}>
        <span className={styles.legendTitle}>{t('quota_pools.legend_pool')}</span>
        <span className={styles.legendItem}>
          <svg width="20" height="8" aria-hidden="true">
            <line x1="1" x2="19" y1="4" y2="4" stroke={color} strokeWidth="2" />
          </svg>
          {t('quota_pools.legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <svg width="20" height="8" aria-hidden="true">
            <line
              x1="1"
              x2="19"
              y1="4"
              y2="4"
              stroke={color}
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          {t('quota_pools.legend_projected')}
        </span>
        {showAccounts && mode === 'remaining' && (
          <span className={styles.legendItem}>
            <svg width="20" height="8" aria-hidden="true">
              <line x1="1" x2="19" y1="4" y2="4" stroke={color} strokeWidth="1" opacity="0.45" />
            </svg>
            {t('quota_pools.legend_accounts')}
          </span>
        )}
      </div>

      {showAccounts && (
        <div className={styles.accounts}>
          <div className={styles.capacityRow}>
            <span className={styles.capacityTitle}>{t('quota_pools.capacity_title')}</span>
            {plans.map((plan) => {
              const planName = planDisplayName(provider, plan) || t('quota_pools.plan_unknown');
              return (
                <label key={plan} className={styles.capacityField}>
                  <span>{planName}</span>
                  <input
                    key={`${capacityKey(provider, plan)}:${resolvePlanCapacity(capacities, provider, plan)}`}
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    inputMode="decimal"
                    defaultValue={resolvePlanCapacity(capacities, provider, plan)}
                    aria-label={t('quota_pools.capacity_input_label', { plan: planName })}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (event.target.value.trim() !== '' && isValidCapacity(value)) {
                        onCapacityChange(provider, plan, value);
                      } else {
                        event.target.value = String(
                          resolvePlanCapacity(capacities, provider, plan)
                        );
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                  <span aria-hidden="true">x</span>
                </label>
              );
            })}
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('quota_pools.col_account')}</th>
                <th scope="col">{t('quota_pools.col_plan')}</th>
                <th scope="col">{t('quota_pools.col_capacity')}</th>
                <th scope="col">{t('quota_pools.col_remaining')}</th>
                <th scope="col">{t('quota_pools.col_reset')}</th>
              </tr>
            </thead>
            <tbody>
              {model.accounts.map((account) => {
                const nextReset = nextResetOf(account.resetAtMs, account.periodMs);
                return (
                  <tr key={account.id}>
                    <td>
                      <span className={sensitive}>{account.label}</span>
                      {account.error && (
                        <span
                          className={styles.accountError}
                          title={t('quota_pools.account_error', { message: account.error })}
                        >
                          {t('quota_pools.account_error_short')}
                        </span>
                      )}
                    </td>
                    <td>
                      {planDisplayName(provider, account.plan) || t('quota_pools.plan_unknown')}
                    </td>
                    <td>{formatCapacity(account.capacity)}</td>
                    <td>
                      {formatPoolPercent(
                        projection.accounts[account.id]?.[0]?.v ?? account.remaining
                      )}
                      <span className={styles.muted}>
                        {' / '}
                        {formatPoolPercent(account.capacity * 100)}
                      </span>
                    </td>
                    <td>
                      {nextReset !== null
                        ? `${formatWeekdayTime(nextReset, locale)} · ${t(
                            'quota_pools.in_duration',
                            {
                              duration: formatPoolDuration(nextReset - now),
                            }
                          )}`
                        : t('quota_pools.reset_unknown')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
