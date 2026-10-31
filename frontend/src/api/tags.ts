import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Tag, TagUpdatePayload } from '@/types'

/**
 * Tag API surface.
 *
 * Contract (mirrored by `backend/src/routes/tags.js`):
 *   GET    /tags     -> Tag[]
 *   POST   /tags     {name, color?} -> Tag
 *   PUT    /tags/:id {name?, color?} -> Tag
 *   DELETE /tags/:id -> 204
 *
 * Deleting a tag also removes its asset bindings, so the assets keep
 * existing but lose that tag.
 */
export const tagsApi = {
  /** The backend serves the full tag list; it is not paginated. */
  all: () => apiGet<Tag[]>('/tags'),

  /** `POST /tags` */
  create: (payload: { name: string; color?: string | null }) =>
    apiPost<Tag>('/tags', payload),

  /** `PUT /tags/:id` — only `name` and `color` are honoured by the backend. */
  update: (id: string, payload: TagUpdatePayload) =>
    apiPut<Tag>(`/tags/${id}`, payload),

  /** `DELETE /tags/:id` */
  remove: (id: string) => apiDelete<void>(`/tags/${id}`),
}
