import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { ApiKey, ApiKeyCreated, ApiKeyScope, ApiKeyUpdatePayload } from '@/types'

/**
 * The scope vocabulary the backend accepts (`KNOWN_SCOPES`).
 *
 * `*` grants everything; the others are independent capabilities.
 */
export const API_KEY_SCOPES: ApiKeyScope[] = ['read', 'upload', 'delete', 'write', '*'];

/** Human labels for the scope chips. */
export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: '读取',
  upload: '上传',
  delete: '删除',
  write: '写入',
  '*': '全部权限',
};

/**
 * API key API surface.
 *
 * Contract (mirrored by `backend/src/routes/apikeys.js`):
 *   GET    /api-keys     -> ApiKey[]
 *   POST   /api-keys     {name, scopes[], expires_at?} -> ApiKeyCreated
 *   PUT    /api-keys/:id {name?, scopes[]?, expires_at?, is_active?} -> ApiKey
 *   DELETE /api-keys/:id -> 204   (soft disable — the row is kept for audit)
 *
 * The backend accepts scopes as an array *or* a CSV string and always
 * answers with an array, so the frontend never splits anything.
 */
export const apiKeysApi = {
  /** The backend serves the full key list; it is not paginated. */
  list: () => apiGet<ApiKey[]>('/api-keys'),

  /**
   * `POST /api-keys`
   *
   * The plain-text key is returned exactly once — the response field is
   * `key`, not `api_key`.
   */
  create: (payload: { name: string; scopes?: ApiKeyScope[]; expires_at?: string | null }) =>
    apiPost<ApiKeyCreated>('/api-keys', payload),

  /** `PUT /api-keys/:id` — `is_active: true` re-enables a revoked key. */
  update: (id: string, payload: ApiKeyUpdatePayload) =>
    apiPut<ApiKey>(`/api-keys/${id}`, payload),

  /** `DELETE /api-keys/:id` — deactivates the key without deleting its row. */
  revoke: (id: string) => apiDelete<void>(`/api-keys/${id}`),
}
