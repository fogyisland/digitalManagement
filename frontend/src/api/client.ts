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
 * The backend issues a **rotating token pair**:
 *
 *   - `access_token`  — short-lived (1 h), sent as `Authorization: Bearer …`
 *   - `refresh_token` — long-lived (30 d), exchanged for a new pair
 *
 * `POST /auth/refresh` **burns** the refresh token it is given and returns a
 * brand-new pair. The old refresh token is dead afterwards, so a successful
 * rotation must write *both* halves back to storage — keeping the old
 * refresh token would lock the user out on the next expiry.
 *
 * Tokens live in `localStorage` under `dam_access_token` / `dam_refresh_token`.
 * `stores/authStore.ts` is the only writer of the *session*; this module is
 * the reader the request interceptor uses, plus the writer of the *rotated*
 * pair (which happens below the store, inside the interceptor).
 */
import axios from 'axios';
import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { TokenPair } from '@/types';

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

/**
 * True when the failure is a "no such resource" rejection (HTTP 404).
 *
 * Several backend routes use 404 as a *normal* answer rather than an
 * error — `GET /jobs/by-comfyui/:job_id` answers 404 when the job has
 * no asset registered yet. Callers use this to turn that into a `null`
 * result instead of an exception.
 */
export function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('response' in error)) return false;
  const response = (error as { response?: { status?: number } }).response;
  return response?.status === 404;
}

export const apiClient = axios.create({ baseURL: '/api/v1', timeout: 30000 });

apiClient.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

/** A request config that has already been through the refresh dance. */
interface RetriableConfig extends AxiosRequestConfig {
  _hasRetried?: boolean;
}

/**
 * Exchange the stored refresh token for a fresh token pair.
 *
 * The call deliberately uses a **bare axios instance** instead of
 * `apiClient`: routing it through `apiClient` would re-enter this module's
 * response interceptor and recurse (a failed refresh is itself a 401).
 *
 * @returns the new pair, or `null` when the session cannot be renewed.
 */
async function rotateTokens(): Promise<TokenPair | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  const baseURL = apiClient.defaults.baseURL ?? '';
  try {
    const response = await axios.post<TokenPair>(
      `${baseURL}/auth/refresh`,
      { refresh_token: refreshToken },
      { timeout: 15000 },
    );
    const pair = response.data;
    if (!pair || !pair.access_token || !pair.refresh_token) return null;
    // The backend burned the old refresh token — store the new pair in full.
    setToken(pair.access_token);
    setRefreshToken(pair.refresh_token);
    return pair;
  } catch (error) {
    console.warn('[auth] token refresh failed:', error);
    return null;
  }
}

/** Endpoints that must never trigger a refresh attempt of their own. */
const NON_REFRESHABLE_PATHS = ['/auth/login', '/auth/refresh'];

function isRefreshable(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0];
  return !NON_REFRESHABLE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const status = error.response?.status;
    const original = error.config as RetriableConfig | undefined;

    // A 401 on an authenticated call usually means the access token expired.
    // Rotate the pair once and replay the request; the retry is flagged so a
    // second 401 cannot loop.
    if (status === 401 && original && !original._hasRetried && isRefreshable(original.url)) {
      original._hasRetried = true;
      const pair = await rotateTokens();
      if (pair) {
        original.headers = {
          ...(original.headers as Record<string, unknown> | undefined),
          Authorization: `Bearer ${pair.access_token}`,
        } as AxiosRequestConfig['headers'];
        return apiClient.request(original);
      }
    }

    if (status === 401 && !location.pathname.startsWith('/login')) {
      setToken(null);
      setRefreshToken(null);
      location.href = '/login';
    }
    return Promise.reject(error);
  },
);

/**
 * Wrapper surface used by the `apikeys/assets/auth/categories/tags/users`
 * sub-modules. Forwarded to `apiClient` with a small adapter so legacy call
 * sites keep working. New code should import `apiClient` directly.
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
 * The backend exposes every update as `PUT` (see `backend/src/routes/*.js`).
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
