import { apiGet, apiPost } from './client'
import type { LoginResponse, TokenPair, User } from '@/types'

/**
 * Authentication API surface.
 *
 * Contract (mirrored by `backend/src/routes/auth.js`):
 *   POST /auth/login            {username, password}         -> LoginResponse
 *   POST /auth/refresh          {refresh_token}               -> TokenPair
 *   POST /auth/logout           (Bearer)                      -> 204
 *   GET  /auth/me               (Bearer)                      -> User
 *   POST /auth/change-password  {old_password, new_password}  -> 204
 */
export const authApi = {
  /** `POST /auth/login` — answers the token pair plus the user profile. */
  login: (username: string, password: string) =>
    apiPost<LoginResponse>('/auth/login', { username, password }),

  /**
   * `POST /auth/refresh` — rotates the pair.
   *
   * The refresh token that is presented is **burned** by the backend; the
   * response carries a new pair that must replace both stored tokens.
   */
  refresh: (refresh_token: string) =>
    apiPost<TokenPair>('/auth/refresh', { refresh_token }),

  /** `POST /auth/logout` — revokes the access token and its session's refresh token. */
  logout: () => apiPost<void>('/auth/logout'),

  /** `GET /auth/me` */
  me: () => apiGet<User>('/auth/me'),

  /** `POST /auth/change-password` — the new password must be ≥ 6 characters. */
  changePassword: (old_password: string, new_password: string) =>
    apiPost<void>('/auth/change-password', { old_password, new_password }),
}
