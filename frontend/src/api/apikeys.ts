import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { ApiKey, ApiKeyCreated, PageResponse } from '@/types'

export const apiKeysApi = {
  list: (params: { keyword?: string; page?: number; page_size?: number } = {}) =>
    apiGet<PageResponse<ApiKey>>('/api/v1/api-keys', params),
  create: (payload: { name: string; scopes: string[]; expires_at?: string; description?: string }) =>
    apiPost<ApiKeyCreated>('/api/v1/api-keys', payload),
  update: (id: number, payload: Partial<ApiKey>) => apiPatch<ApiKey>(`/api/v1/api-keys/${id}`, payload),
  revoke: (id: number) => apiDelete(`/api/v1/api-keys/${id}`),
}
