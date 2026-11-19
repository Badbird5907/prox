import { useCallback, useEffect, useRef, useState } from 'react';
import {
  quotaPoolsApi,
  type QuotaPoolsRefreshResult,
  type QuotaPoolsSnapshot,
} from '@/services/api/quotaPools';
import { useQuotaStore } from '@/stores';
import { DAY_MS, MINUTE_MS } from './poolModel';

export const POOL_AUTO_REFRESH_MS = MINUTE_MS;
export const POOL_DEFAULT_HISTORY_MS = 7 * DAY_MS;

export interface QuotaPoolsState {
  data: QuotaPoolsSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  /** The backend does not expose /quota/pools (404/405); hide the pooled view. */
  unsupported: boolean;
  reload: () => Promise<void>;
  refreshAll: () => Promise<QuotaPoolsRefreshResult | null>;
}

const statusOf = (err: unknown) =>
  err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : 0;

/**
 * Pooled quota data with stale-request guards: a response is applied only when it
 * belongs to the latest request of the current session (quota cacheGeneration).
 * Polls every minute while the document is visible.
 */
export function useQuotaPools(enabled: boolean, historyFrom: number | null): QuotaPoolsState {
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [data, setData] = useState<QuotaPoolsSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === requestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    const to = Date.now();
    const from = historyFrom ?? to - POOL_DEFAULT_HISTORY_MS;
    try {
      const snapshot = await quotaPoolsApi.get({ from, to });
      if (!isCurrent()) return;
      setData(snapshot);
      setError('');
      setUnsupported(false);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const status = statusOf(err);
      if (status === 404 || status === 405) {
        setUnsupported(true);
        setData(null);
        setError('');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [enabled, historyFrom, sessionGeneration]);

  const refreshAll = useCallback(async () => {
    if (!enabled || unsupported) return null;
    setRefreshing(true);
    try {
      const result = await quotaPoolsApi.refresh();
      await reload();
      return result;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [enabled, reload, unsupported]);

  useEffect(() => {
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    if (!enabled || unsupported || typeof document === 'undefined') return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => void reload(), POOL_AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void reload();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, reload, unsupported]);

  return { data, loading, refreshing, error, unsupported, reload, refreshAll };
}
