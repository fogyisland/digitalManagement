import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from './client';
import { toError } from '@/utils/errors';

interface State<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => Promise<void>;
}

export interface UseApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

/**
 * Fetch a JSON endpoint and expose its lifecycle.
 *
 * ## Why this was rewritten
 *
 * The previous version had three defects that made failure states
 * unreachable in the UI:
 *
 *  1. **`loading` never cleared on failure.** `setLoading(false)` sat after
 *     the `await`, so a rejected request left `loading === true` forever.
 *     Every page gates its error banner on `!loading`, so **the error was
 *     never rendered** — the user stared at a permanent skeleton.
 *  2. **`reload()` fired two requests.** It bumped a `tick` (which the
 *     effect watched) *and* called the fetcher directly, so every manual
 *     refresh doubled the traffic and raced its own two responses.
 *  3. **Out-of-order responses could win.** A slow request that resolved
 *     after a newer one overwrote the newer data.
 *
 * The fix: one code path (`run`), `try/catch/finally` around it, a request
 * sequence number so only the newest response is applied, and `reload`
 * simply re-runs it.
 */
export function useApi<T>(path: string | null, init?: UseApiInit): State<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);

  /** Monotonic request id — only the newest response may touch state. */
  const seq = useRef(0);
  /** Guards against `setState` after unmount (React 18 no longer warns). */
  const alive = useRef(true);

  /**
   * The request config is usually an inline object literal, so its identity
   * changes every render. We keep the latest in a ref and derive a stable
   * string key for the effect dependency instead.
   */
  const initRef = useRef<UseApiInit | undefined>(init);
  initRef.current = init;
  const method = init?.method ?? 'GET';
  const bodyKey = init?.body === undefined ? '' : JSON.stringify(init.body);
  const requestKey = `${method}|${bodyKey}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (): Promise<void> => {
    if (!path) {
      setData(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }

    const current = ++seq.current;
    const config = initRef.current ?? {};
    setLoading(true);
    setError(undefined);

    try {
      const res = await apiClient.request<T>({
        url: path,
        method: config.method ?? 'GET',
        data: config.body,
      });
      if (!alive.current || current !== seq.current) return;
      setData(res.data);
    } catch (e: unknown) {
      if (!alive.current || current !== seq.current) return;
      // Clear stale rows: a filter change that failed must not keep
      // showing the previous result set next to an error.
      setData(undefined);
      setError(toError(e, '加载失败'));
    } finally {
      if (alive.current && current === seq.current) setLoading(false);
    }
    // `requestKey` stands in for the request config; `initRef` carries the
    // current values. See the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, requestKey]);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, reload: run };
}
