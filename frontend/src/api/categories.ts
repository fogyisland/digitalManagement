import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { Category } from '@/types'

export const categoriesApi = {
  tree: () => apiGet<Category[]>('/api/v1/categories/tree'),
  list: (parent_id?: number) => apiGet<Category[]>('/api/v1/categories', { parent_id }),
  create: (payload: Partial<Category>) => apiPost<Category>('/api/v1/categories', payload),
  update: (id: number, payload: Partial<Category>) => apiPatch<Category>(`/api/v1/categories/${id}`, payload),
  remove: (id: number) => apiDelete(`/api/v1/categories/${id}`),
}
