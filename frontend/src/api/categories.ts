import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Category } from '@/types'

/**
 * The backend serves a flat category list (`GET /categories`, one row per
 * category with a `parent_id` column). The nested shape the UI renders is
 * derived here so the tree can be shown without a dedicated endpoint.
 */
function buildCategoryTree(nodes: Category[]): Category[] {
  const byId = new Map<string, Category>()
  const roots: Category[] = []
  for (const node of nodes) {
    byId.set(String(node.id), { ...node, children: [] })
  }
  for (const node of nodes) {
    const current = byId.get(String(node.id))
    if (!current) continue
    const parentId = node.parent_id === null || node.parent_id === undefined ? null : String(node.parent_id)
    const parent = parentId === null ? undefined : byId.get(parentId)
    if (parent) {
      parent.children?.push(current)
    } else {
      roots.push(current)
    }
  }
  return roots
}

export const categoriesApi = {
  tree: () => apiGet<Category[]>('/categories').then(buildCategoryTree),
  list: (parent_id?: number) => apiGet<Category[]>('/categories', { parent_id }),
  create: (payload: Partial<Category>) => apiPost<Category>('/categories', payload),
  update: (id: number, payload: Partial<Category>) => apiPut<Category>(`/categories/${id}`, payload),
  remove: (id: number) => apiDelete(`/categories/${id}`),
}
