import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  DAY_MS,
  HOUR_MS,
  valueAt,
  type PoolModel,
  type ResetLabel,
  type SeriesPoint,
} from './poolModel';
import {
  formatBurn,
  formatDayTick,
  formatPoolPercent,
  formatSignedPercent,
  formatWeekdayTime,
  localMidnights,
  niceCeil,
} from './poolFormat';
import type { PoolChartMode } from './poolPrefs';
import styles from './PoolChart.module.scss';

export interface PoolChartProps {
  model: PoolModel;
  mode: PoolChartMode;
  multiplier: number;
  now: number;
  spanStart: number;
  spanEnd: number;
  color: string;
  showAccounts: boolean;
  locale: string;
  ariaLabel: string;
  /** Fixed width for static rendering; otherwise measured. */
  initialWidth?: number;
}

const HEIGHT = 310;
const PAD = { left: 52, right: 14, top: 44, bottom: 30 };
const LABEL_MIN_GAP_X = 38;

/** Keep the points inside the span plus one neighbour on each side. */
function sliceToSpan(series: SeriesPoint[], start: number, end: number): SeriesPoint[] {
  let first = 0;
  while (first < series.length - 1 && series[first + 1].t <= start) first += 1;
  let last = series.length - 1;
  while (last > 0 && series[last - 1].t >= end) last -= 1;
  return series.slice(first, last + 1);
}

const linePath = (points: Array<[number, number]>) =>
  points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join('');

const areaPath = (points: Array<[number, number]>, baseline: number) => {
  if (points.length < 2) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)}L${last[0].toFixed(1)},${baseline}L${first[0].toFixed(1)},${baseline}Z`;
};

interface Hover {
  t: number;
  v: number;
  projected: boolean;
}

export function PoolChart({
  model,
  mode,
  multiplier,
  now,
  spanStart,
  spanEnd,
  color,
  showAccounts,
  locale,
  ariaLabel,
  initialWidth = 960,
}: PoolChartProps) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  const [hover, setHover] = useState<Hover | null>(null);
  const gradientId = `pool-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const clipId = `${gradientId}-clip`;

  useEffect(() => {
    const element = wrapRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotH;
  const span = Math.max(1, spanEnd - spanStart);
  const x = (time: number) => PAD.left + ((time - spanStart) / span) * plotW;
  const timeAtX = (px: number) => spanStart + ((px - PAD.left) / plotW) * span;

  const drainNow = model.burnPerHour * multiplier;
  const recorded = mode === 'remaining' ? model.recorded.pool : model.drainRecorded;
  const projected = useMemo<SeriesPoint[]>(
    () =>
      mode === 'remaining'
        ? model.projection.pool
        : [
            { t: now, v: drainNow },
            { t: model.horizonEnd, v: drainNow },
          ],
    [mode, model, now, drainNow]
  );

  const yMax = useMemo(() => {
    if (mode === 'remaining') return model.capacityTotal > 0 ? model.capacityTotal : 100;
    const peak = Math.max(drainNow, model.burnPerHour, ...model.drainRecorded.map((p) => p.v), 1);
    return niceCeil(peak * 1.15);
  }, [mode, model, drainNow]);
  const y = (value: number) => PAD.top + (1 - Math.min(value, yMax * 1.05) / yMax) * plotH;

  const toPoints = (series: SeriesPoint[]): Array<[number, number]> =>
    sliceToSpan(series, spanStart, spanEnd).map((point) => [x(point.t), y(point.v)]);

  const recordedPts = toPoints(recorded);
  const projectedPts = toPoints(projected);

  const formatValue = (value: number) =>
    mode === 'remaining' ? formatPoolPercent(value) : formatBurn(value);

  /* ---------- axes ---------- */

  const yTicks = [0, yMax / 2, yMax];
  const midnights = localMidnights(spanStart - DAY_MS, spanEnd);
  const dayWidth = (DAY_MS / span) * plotW;
  const labelEvery = dayWidth >= 44 ? 1 : dayWidth >= 22 ? 2 : 4;
  const dayLabels = midnights
    .map((midnight, index) => ({ t: midnight + DAY_MS / 2, index }))
    .filter(({ t: time, index }) => time > spanStart && time < spanEnd && index % labelEvery === 0);

  /* ---------- reset labels ---------- */

  const resetMarks = useMemo(() => {
    if (mode !== 'remaining') return [];
    const placed: Array<{ x: number; y: number; text: string; key: string }> = [];
    const add = (labels: ResetLabel[], series: SeriesPoint[], prefix: string) => {
      labels.forEach((label, index) => {
        if (label.tEnd < spanStart || label.tEnd > spanEnd) return;
        const value = valueAt(series, label.tEnd);
        if (value === null) return;
        const px = PAD.left + ((label.tEnd - spanStart) / span) * plotW;
        let py = PAD.top + (1 - Math.min(value, yMax * 1.05) / yMax) * plotH - 8;
        for (const other of placed) {
          if (Math.abs(other.x - px) < LABEL_MIN_GAP_X && Math.abs(other.y - py) < 12) {
            py = other.y - 13;
          }
        }
        py = Math.max(PAD.top - 18, py);
        placed.push({
          x: px,
          y: py,
          text: formatSignedPercent(label.gain),
          key: `${prefix}${index}`,
        });
      });
    };
    add(model.recordedResets, model.recorded.pool, 'r');
    add(model.projection.resetLabels, model.projection.pool, 'p');
    return placed;
  }, [mode, model, spanStart, spanEnd, span, plotW, plotH, yMax]);

  const emptyAt = mode === 'remaining' ? model.projection.poolEmptyAt : null;
  const showEmpty = emptyAt !== null && emptyAt >= spanStart && emptyAt <= spanEnd;
  const nowVisible = now >= spanStart && now <= spanEnd;

  /* ---------- hover ---------- */

  const hoverAt = (time: number) => {
    const clamped = Math.min(spanEnd, Math.max(spanStart, time));
    const projectedSide = clamped > now;
    const value = valueAt(projectedSide ? projected : recorded, clamped);
    setHover(value === null ? null : { t: clamped, v: value, projected: projectedSide });
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    hoverAt(timeAtX(((event.clientX - rect.left) / rect.width) * width));
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Escape') {
      setHover(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? DAY_MS : HOUR_MS;
    const base = hover?.t ?? Math.min(spanEnd, Math.max(spanStart, now));
    hoverAt(base + (event.key === 'ArrowLeft' ? -step : step));
  };

  const tooltip = hover
    ? t(mode === 'remaining' ? 'quota_pools.tooltip_remaining' : 'quota_pools.tooltip_drain', {
        time: formatWeekdayTime(hover.t, locale),
        value: formatValue(hover.v),
        kind: t(hover.projected ? 'quota_pools.kind_projected' : 'quota_pools.kind_recorded'),
      })
    : '';

  /* ---------- account overlays ---------- */

  const accountLines =
    showAccounts && mode === 'remaining'
      ? model.accounts.map((account) => ({
          id: account.id,
          recorded: toPoints(model.recorded.accounts[account.id] ?? []),
          projected: toPoints(model.projection.accounts[account.id] ?? []),
        }))
      : [];

  return (
    <div className={styles.chart} ref={wrapRef}>
      {hover && (
        <div className={styles.tooltip} role="status">
          {tooltip}
        </div>
      )}
      <svg
        className={styles.svg}
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={handleKeyDown}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top - 30} width={plotW} height={plotH + 30} />
          </clipPath>
        </defs>

        {/* Horizontal gridlines with value labels */}
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              className={styles.grid}
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className={styles.axisLabel} x={PAD.left - 10} y={y(tick) + 4} textAnchor="end">
              {formatValue(tick)}
            </text>
          </g>
        ))}

        {/* Day gridlines and labels */}
        {midnights
          .filter((midnight) => midnight > spanStart && midnight < spanEnd)
          .map((midnight) => (
            <line
              key={midnight}
              className={styles.gridDay}
              x1={x(midnight)}
              x2={x(midnight)}
              y1={PAD.top}
              y2={baseline}
            />
          ))}
        {dayLabels.map(({ t: time }) => (
          <text
            key={time}
            className={styles.axisLabel}
            x={x(time)}
            y={baseline + 20}
            textAnchor="middle"
          >
            {formatDayTick(time, locale)}
          </text>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {recordedPts.length > 1 && (
            <path d={areaPath(recordedPts, baseline)} fill={`url(#${gradientId})`} />
          )}
          {projectedPts.length > 1 && (
            <path
              d={areaPath(projectedPts, baseline)}
              fill={`url(#${gradientId})`}
              opacity={0.55}
            />
          )}

          {accountLines.map((line) => (
            <g key={line.id} className={styles.accountLine}>
              {line.recorded.length > 1 && (
                <path d={linePath(line.recorded)} stroke={color} fill="none" strokeWidth={1} />
              )}
              {line.projected.length > 1 && (
                <path
                  d={linePath(line.projected)}
                  stroke={color}
                  fill="none"
                  strokeWidth={1}
                  strokeDasharray="3 4"
                />
              )}
            </g>
          ))}

          {recordedPts.length > 1 && (
            <path
              d={linePath(recordedPts)}
              stroke={color}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
            />
          )}
          {projectedPts.length > 1 && (
            <path
              d={linePath(projectedPts)}
              stroke={color}
              fill="none"
              strokeWidth={2}
              strokeDasharray="6 5"
              strokeLinejoin="round"
            />
          )}
        </g>

        {resetMarks.map((mark) => (
          <text
            key={mark.key}
            className={styles.resetLabel}
            x={mark.x}
            y={mark.y}
            textAnchor="middle"
          >
            {mark.text}
          </text>
        ))}

        {nowVisible && (
          <g>
            <line className={styles.nowLine} x1={x(now)} x2={x(now)} y1={22} y2={baseline + 28} />
            <text className={styles.nowLabel} x={x(now)} y={14} textAnchor="middle">
              {t('quota_pools.now')}
            </text>
            {projectedPts.length > 0 && valueAt(projected, now) !== null && (
              <circle cx={x(now)} cy={y(valueAt(projected, now) ?? 0)} r={3.5} fill={color} />
            )}
          </g>
        )}

        {showEmpty && emptyAt !== null && (
          <g>
            <circle
              className={styles.emptyMarker}
              cx={x(emptyAt)}
              cy={baseline}
              r={5.5}
              stroke={color}
            />
            <text
              className={styles.emptyLabel}
              x={Math.min(PAD.left + plotW - 60, Math.max(PAD.left + 60, x(emptyAt)))}
              y={baseline - 12}
              textAnchor="middle"
            >
              {t('quota_pools.empty_at', { time: formatWeekdayTime(emptyAt, locale) })}
            </text>
          </g>
        )}

        {hover && (
          <g pointerEvents="none">
            <line
              className={styles.crosshair}
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={PAD.top}
              y2={baseline}
            />
            <circle
              cx={x(hover.t)}
              cy={y(hover.v)}
              r={4}
              fill={color}
              className={styles.hoverDot}
            />
          </g>
        )}
      </svg>
    </div>
  );
}
