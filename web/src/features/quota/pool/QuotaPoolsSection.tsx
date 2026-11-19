import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconChevronLeft } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/features/authFiles/constants';
import type { QuotaPoolsSnapshot } from '@/services/api/quotaPools';
import { PoolCard } from './PoolCard';
import { HOUR_MS, buildPoolAccounts, buildPoolModel, poolSpan } from './poolModel';
import { formatMonthDay } from './poolFormat';
import {
  POOL_BURN_WINDOWS_HOURS,
  POOL_CHART_MODES,
  POOL_FUTURE_USAGE,
  POOL_FUTURE_USAGE_IDS,
  capacityKey,
  resolvePlanCapacity,
  type FutureUsageId,
  type PoolChartMode,
  type PoolPrefs,
} from './poolPrefs';
import styles from './QuotaPoolsSection.module.scss';

export interface QuotaPoolsSectionProps {
  data: QuotaPoolsSnapshot;
  /** Providers to draw, in order. */
  providers: string[];
  prefs: PoolPrefs;
  onPrefsChange: (next: PoolPrefs) => void;
  now: number;
  offsetWeeks: number;
  onOffsetWeeksChange: (next: number) => void;
  locale: string;
  resolvedTheme: ResolvedTheme;
  /** Fixed chart width for static rendering. */
  chartWidth?: number;
}

export function QuotaPoolsSection({
  data,
  providers,
  prefs,
  onPrefsChange,
  now,
  offsetWeeks,
  onOffsetWeeksChange,
  locale,
  resolvedTheme,
  chartWidth,
}: QuotaPoolsSectionProps) {
  const { t } = useTranslation();
  const burnLabelId = useId();
  const span = poolSpan(now, offsetWeeks);
  const multiplier = POOL_FUTURE_USAGE[prefs.future];

  const models = useMemo(
    () =>
      providers.map((provider) => {
        const accounts = buildPoolAccounts(
          data.credentials,
          data.history,
          provider,
          (name, plan) => resolvePlanCapacity(prefs.capacities, name, plan),
          now
        );
        return {
          provider,
          model: buildPoolModel(accounts, {
            now,
            spanStart: span.start,
            spanEnd: span.end,
            burnWindowMs: prefs.burnHours * HOUR_MS,
            multiplier,
          }),
        };
      }),
    [data, providers, prefs.capacities, prefs.burnHours, multiplier, now, span.start, span.end]
  );

  const update = (patch: Partial<PoolPrefs>) => onPrefsChange({ ...prefs, ...patch });

  const futureOptions = POOL_FUTURE_USAGE_IDS.map((id) => ({
    value: id,
    label: t(`quota_pools.future_${id}`),
  }));

  return (
    <div className={styles.section}>
      <div className={styles.toolbar} role="toolbar" aria-label={t('quota_pools.toolbar_label')}>
        <div className={styles.segmented} role="group" aria-label={t('quota_pools.mode_label')}>
          {POOL_CHART_MODES.map((mode: PoolChartMode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={prefs.mode === mode}
              className={prefs.mode === mode ? styles.segmentActive : undefined}
              onClick={() => update({ mode })}
            >
              {t(mode === 'remaining' ? 'quota_pools.mode_remaining' : 'quota_pools.mode_drain')}
            </button>
          ))}
        </div>

        <div className={styles.group}>
          <span className={styles.groupLabel} id={burnLabelId}>
            {t('quota_pools.burn_label')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
            {POOL_BURN_WINDOWS_HOURS.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={prefs.burnHours === hours}
                className={prefs.burnHours === hours ? styles.segmentActive : undefined}
                onClick={() => update({ burnHours: hours })}
              >
                {t('quota_pools.burn_window', { hours })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('quota_pools.future_label')}</span>
          <div className={styles.select}>
            <Select
              value={prefs.future}
              options={futureOptions}
              onChange={(value) => update({ future: value as FutureUsageId })}
              ariaLabel={t('quota_pools.future_label')}
              size="sm"
            />
          </div>
        </div>

        <button
          type="button"
          className={`${styles.toggle} ${prefs.showAccounts ? styles.toggleActive : ''}`}
          aria-pressed={prefs.showAccounts}
          onClick={() => update({ showAccounts: !prefs.showAccounts })}
        >
          {t('quota_pools.accounts_toggle')}
        </button>

        <div className={styles.range}>
          <span className={styles.rangeLabel}>
            {t('quota_pools.range', {
              from: formatMonthDay(span.start, locale),
              to: formatMonthDay(span.end, locale),
            })}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('quota_pools.range_prev')}
            title={t('quota_pools.range_prev')}
            onClick={() => onOffsetWeeksChange(offsetWeeks - 1)}
          >
            <IconChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={styles.todayButton}
            disabled={offsetWeeks === 0}
            onClick={() => onOffsetWeeksChange(0)}
          >
            {t('quota_pools.today')}
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.flip}`}
            aria-label={t('quota_pools.range_next')}
            title={t('quota_pools.range_next')}
            onClick={() => onOffsetWeeksChange(offsetWeeks + 1)}
          >
            <IconChevronLeft size={16} />
          </button>
        </div>
      </div>

      {models.map(({ provider, model }) => (
        <PoolCard
          key={provider}
          provider={provider}
          model={model}
          mode={prefs.mode}
          multiplier={multiplier}
          burnHours={prefs.burnHours}
          now={now}
          spanStart={span.start}
          spanEnd={span.end}
          locale={locale}
          resolvedTheme={resolvedTheme}
          showAccounts={prefs.showAccounts}
          showEmails={prefs.showEmails}
          capacities={prefs.capacities}
          chartWidth={chartWidth}
          onCapacityChange={(name, plan, capacity) =>
            update({ capacities: { ...prefs.capacities, [capacityKey(name, plan)]: capacity } })
          }
        />
      ))}
    </div>
  );
}
