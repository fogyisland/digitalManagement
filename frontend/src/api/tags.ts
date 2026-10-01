import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { Tag, PageResponse } from '@/types'

export const tagsApi = {
  list: (params: { keyword?: string; page?: number; page_size?: number } = {}) =>
    apiGet<PageResponse<Tag>>('/api/v1/tags', params),
  all: () => apiGet<Tag[]>('/api/v1/tags/all'),
  create: (payload: { name: string; color?: string; description?: string }) =>
    apiPost<Tag>('/api/v1/tags', payload),
  update: (id: number, payload: Partial<Tag>) => apiPatch<Tag>(`/api/v1/tags/${id}`, payload),
  remove: (id: number) => apiDelete(`/api/v1/tags/${id}`),
}
