import { useEffect, useState } from 'react';
import { apiClient } from './client';

interface State<T> { data?: T; error?: Error; loading: boolean; reload: () => Promise<void>; }

export function useApi<T>(path: string | null, init?: { method?: 'GET'|'POST'|'PUT'|'DELETE'; body?: unknown }): State<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = async () => {
    if (!path) return;
    setLoading(true); setError(undefined);
    const res = await apiClient.request<T>({ url: path, method: init?.method || 'GET', data: init?.body });
    setData(res.data); setLoading(false);
  };
  useEffect(() => { reload().catch(e => setError(e as Error)); /* eslint-disable-next-line */ }, [path, tick]);
  return { data, error, loading, reload: async () => { setTick(t=>t+1); await reload(); } };
}
