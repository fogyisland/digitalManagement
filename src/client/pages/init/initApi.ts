/**
 * The setup wizard's API surface.
 *
 * The wizard talks to `/api/init`, which is **not** the admin namespace the
 * shared `apiClient` points at (`/api/v1`) and which authenticates with a
 * one-shot token instead of a bearer token. It therefore gets its own axios
 * instance rather than borrowing the admin one — mixing the two would send
 * the wizard token on every admin request and the admin token on every
 * wizard request.
 *
 * Contract (mirrored by `src/server/routes/init.js`):
 *   GET  /status       -> InitStatus
 *   POST /database     DatabaseInput -> InitResult
 *   POST /admin        AdminInput    -> InitResult
 *   POST /seed         -> SeedResult
 *   GET  /env-preview  -> { content }
 *
 * The `X-Init-Token` header is required on everything but `status`; the token
 * is printed by the backend on boot (or comes from `INIT_TOKEN`).
 */
import axios from 'axios';
import type { AxiosInstance } from 'axios';

/** The wizard's step state, as the backend reports it. */
export interface InitStatus {
  initialized: boolean;
  steps: {
    database: boolean;
    admin: boolean;
    seed: boolean;
  };
}

/** The database connection values the first page collects. */
export interface DatabaseInput {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** The administrator and the first tenant the second page collects. */
export interface AdminInput {
  username: string;
  password: string;
  email?: string;
  tenantName: string;
}

export interface InitResult {
  ok: boolean;
  [key: string]: unknown;
}

export interface SeedResult extends InitResult {
  jwt_secret_written: boolean;
}

/** Where the one-shot token is kept: memory only, never storage. */
let initToken = '';

/**
 * Set the `X-Init-Token` every wizard request carries.
 *
 * @param token
 */
export function setInitToken(token: string): void {
  initToken = token;
}

/**
 * A wizard request that answers the parsed body.
 *
 * @param method
 * @param url relative to `/api/init`
 * @param body
 * @returns the parsed response body
 */
async function call<T>(method: 'get' | 'post', url: string, body?: unknown): Promise<T> {
  const client: AxiosInstance = axios.create({
    baseURL: '/api/init',
    headers: initToken ? { 'X-Init-Token': initToken } : {},
    timeout: 30000,
  });
  const response = method === 'get' ? await client.get<T>(url) : await client.post<T>(url, body);
  return response.data;
}

/**
 * Turn an axios failure into the message the wizard shows.
 *
 * The backend answers `{ detail }` for a refused step; anything else (a
 * network failure, a 500) falls back to the status line so the operator is
 * never left with an empty error box.
 *
 * @param error
 * @returns the message
 */
export function describeInitError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
    if (error.response) return `请求失败（HTTP ${error.response.status}）`;
    return '无法连接到服务端，请确认后端已启动';
  }
  return error instanceof Error ? error.message : String(error);
}

export const initApi = {
  /** `GET /status` — never requires the token. */
  status: () => call<InitStatus>('get', '/status'),

  /** `POST /database` — tests the connection, creates the schema, writes `.env`. */
  saveDatabase: (input: DatabaseInput) => call<InitResult>('post', '/database', input),

  /** `POST /admin` — creates the first tenant and its administrator. */
  saveAdmin: (input: AdminInput) => call<InitResult>('post', '/admin', input),

  /**
   * `POST /seed` — seeds the catalogue, hot-reloads the running instance
   * onto the configured database, and writes the JWT secret last. The
   * process keeps running: the reply means the instance is live.
   */
  runSeed: () => call<SeedResult>('post', '/seed'),

  /** `GET /env-preview` — the file that will be written, secrets masked. */
  envPreview: () => call<{ content: string }>('get', '/env-preview'),
};
