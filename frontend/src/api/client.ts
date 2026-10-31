/**
 * Shared HTTP client.
 *
 * ## URL contract
 *
 * `apiClient` owns the API base URL (`/api/v1`). Every path handed to it MUST
 * be relative to that base (`/auth/login`), never the fully qualified
 * `/api/v1/auth/login`. Axios concatenates baseURL and url, so a path that
 * already carries the prefix resolves to `/api/v1/api/v1/auth/login` and
 * answers 404. `tests/contract.test.js` enforces this rule across the whole
 * `src/` tree, so a regression fails the test run instead of the browser.
 *
 * ## Token contract
 *
 * Tokens live in `localStorage` under `dam_access_token` / `dam_refresh_token`.
 * `stores/authStore.ts` is the only writer; this module is the reader that the
 * request interceptor uses. Both sides must agree on the key names — the
 * interceptor cannot see a token written under a different key, and the request
 * then goes out unauthenticated.
 */
import axios from 'axios';
import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

const ACCESS_TOKEN_KEY = 'dam_access_token';
const REFRESH_TOKEN_KEY = 'dam_refresh_token';

export function getToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
  }
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token: string | null): void {
  if (token) {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}

/**
 * True when the failure was an authentication rejection (HTTP 401).
 *
 * Used to tell "your session ended" apart from "the network is down" — only
 * the former may sign the user out.
 */
export function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('response' in error)) return false;
  const response = (error as { response?: { status?: number } }).response;
  return response?.status === 401;
}

export const apiClient = axios.create({ baseURL: '/api/v1', timeout: 30000 });

apiClient.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401 && !location.pathname.startsWith('/login')) {
      setToken(null);
      setRefreshToken(null);
      location.href = '/login';
    }
    return Promise.reject(error);
  },
);

/**
 * Pre-Task-10 wrapper surface (apikeys/assets/auth/categories/tags/users
 * sub-files import these names). Forwarded to `apiClient` with a small
 * adapter so legacy call sites keep working. New code should import
 * `apiClient` directly.
 *
 * Paths passed to these helpers are relative to `apiClient`'s baseURL
 * (`/api/v1`) — see the URL contract above.
 *
 * `http` is an axios instance with the same baseURL so callers using
 * `http.put/post` (e.g. chunked upload in assets.ts) continue to compile.
 * `unwrap(resp)` returns `resp.data` for callers that previously consumed a
 * bare payload.
 */
export const http = apiClient;

export async function apiGet<T>(url: string, params?: unknown): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.get<T>(url, {
    params: params as Record<string, unknown> | undefined,
  });
  return resp.data;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.post<T>(url, body, config);
  return resp.data;
}

/**
 * The backend exposes every update as `PUT` (see `backend/src/server.js` —
 * `app.put('/api/v1/assets/:id')`, `app.put('/api/v1/categories/:id')`).
 * There is deliberately no `apiPatch` helper: a PATCH request to those
 * routes matches no handler and answers 404.
 */
export async function apiPut<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.put<T>(url, body, config);
  return resp.data;
}

export async function apiDelete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const resp: AxiosResponse<T> = await apiClient.delete<T>(url, config);
  return resp.data;
}

export function unwrap<T>(resp: AxiosResponse<T>): T {
  return resp.data;
}
