import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Tag } from '@/types'

export const tagsApi = {
  /** The backend serves the full tag list; it is not paginated. */
  all: () => apiGet<Tag[]>('/tags'),
  create: (payload: { name: string; color?: string; description?: string }) =>
    apiPost<Tag>('/tags', payload),
  update: (id: number, payload: Partial<Tag>) => apiPut<Tag>(`/tags/${id}`, payload),
  remove: (id: number) => apiDelete(`/tags/${id}`),
}
