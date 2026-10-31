import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type {
  PageResponse,
  User,
  UserCreatePayload,
  UserListParams,
  UserUpdatePayload,
} from '@/types'

/**
 * User management API surface (admin only).
 *
 * Contract (mirrored by `backend/src/routes/users.js`):
 *   GET    /users                ?keyword=&role=&status=&page=&page_size= -> PageResponse<User>
 *   POST   /users                {username, password, email?, display_name?, role} -> User
 *   PUT    /users/:id            {email?, display_name?, role?, status?} -> User
 *   DELETE /users/:id            -> 204
 *   POST   /users/:id/reset-password  {new_password} -> 204
 *
 * The backend refuses to demote, disable or delete the **last active admin**
 * and refuses to delete the caller's own account — those rejections surface
 * as 400 responses.
 */
export const usersApi = {
  /** `GET /users` — the backend also accepts `q` as an alias for `keyword`. */
  list: (params: UserListParams = {}) =>
    apiGet<PageResponse<User>>('/users', params),

  /** `POST /users` */
  create: (payload: UserCreatePayload) => apiPost<User>('/users', payload),

  /** `PUT /users/:id` */
  update: (id: string, payload: UserUpdatePayload) =>
    apiPut<User>(`/users/${id}`, payload),

  /** `DELETE /users/:id` */
  remove: (id: string) => apiDelete<void>(`/users/${id}`),

  /**
   * `POST /users/:id/reset-password`
   *
   * The backend reads `new_password` from the query string **or** the body;
   * the body is used here because a password in a URL ends up in access logs
   * and browser history.
   */
  resetPassword: (id: string, new_password: string) =>
    apiPost<void>(`/users/${id}/reset-password`, { new_password }),
}
