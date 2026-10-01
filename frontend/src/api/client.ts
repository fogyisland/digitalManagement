import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

const TOKEN_KEY = 'dam.token';

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t: string | null) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

export const apiClient = axios.create({ baseURL: '/api/v1', timeout: 30000 });

apiClient.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

apiClient.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
      setToken(null);
      location.href = '/login';
    }
    return Promise.reject(err);
  }
);

/**
 * Pre-Task-10 wrapper surface (apikeys/assets/auth/categories/tags/users sub-files
 * import these names). Forwarded to `apiClient` with a small adapter so legacy
 * call sites keep working. New code should import `apiClient` directly.
 *
 * `http` is an axios instance with the same baseURL so callers using
 * `http.put/postForm` (e.g. chunked upload in assets.ts) continue to compile.
 * `unwrap(resp)` returns `resp.data` for callers that previously consumed a
 * bare payload.
 */
export const http = apiClient;

export async function apiGet<T>(url: string, params?: unknown): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.get<T>(url, { params: params as Record<string, unknown> | undefined });
  return resp.data;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.post<T>(url, body, config);
  return resp.data;
}

export async function apiPatch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.patch<T>(url, body, config);
  return resp.data;
}

export async function apiDelete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.delete<T>(url, config);
  return resp.data;
}

export function unwrap<T>(resp: AxiosResponse<T>): T {
  return resp.data;
}
