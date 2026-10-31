import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Category, CategoryUpdatePayload } from '@/types'

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

/**
 * Category API surface.
 *
 * Contract (mirrored by `backend/src/routes/categories.js`):
 *   GET    /categories     -> Category[]   (flat, `?parent_id=` filters)
 *   POST   /categories     {name, parent_id?, description?, sort_order?} -> Category
 *   PUT    /categories/:id {name?, parent_id?, description?, sort_order?} -> Category
 *   DELETE /categories/:id -> 204
 *
 * Deleting a category detaches it from its assets (they become
 * uncategorised) and promotes its children to the top level.
 */
export const categoriesApi = {
  /** The flat list, exactly as the backend returns it. */
  list: (parent_id?: string) => apiGet<Category[]>('/categories', { parent_id }),

  /** The same list, nested into a tree on the frontend. */
  tree: () => apiGet<Category[]>('/categories').then(buildCategoryTree),

  /** `POST /categories` */
  create: (payload: {
    name: string
    parent_id?: string | null
    description?: string | null
    sort_order?: number
  }) => apiPost<Category>('/categories', payload),

  /** `PUT /categories/:id` */
  update: (id: string, payload: CategoryUpdatePayload) =>
    apiPut<Category>(`/categories/${id}`, payload),

  /** `DELETE /categories/:id` */
  remove: (id: string) => apiDelete<void>(`/categories/${id}`),
}
