import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { ApiKey, ApiKeyCreated } from '@/types'

export const apiKeysApi = {
  /** The backend serves the full key list; it is not paginated. */
  list: () => apiGet<ApiKey[]>('/api-keys'),
  create: (payload: { name: string; scopes: string[]; expires_at?: string; description?: string }) =>
    apiPost<ApiKeyCreated>('/api-keys', payload),
  update: (id: number, payload: Partial<ApiKey>) => apiPut<ApiKey>(`/api-keys/${id}`, payload),
  revoke: (id: number) => apiDelete(`/api-keys/${id}`),
}
