import { apiGet, apiPost } from './client'
import type { LoginResponse, TenantDirectoryResponse, TokenPair, User } from '@/types'

/**
 * Authentication API surface.
 *
 * Contract (mirrored by `backend/src/routes/auth.js`):
 *   POST /auth/login            {username, password, tenant?} -> LoginResponse
 *   POST /auth/platform-login   {username, password}          -> LoginResponse
 *   GET  /auth/tenants          (public)                      -> TenantDirectoryResponse
 *   POST /auth/refresh          {refresh_token}               -> TokenPair
 *   POST /auth/logout           (Bearer)                      -> 204
 *   GET  /auth/me               (Bearer)                      -> User
 *   POST /auth/change-password  {old_password, new_password}  -> 204
 *
 * ## Two doors
 *
 * `login` is the **tenant** door — it names the tenant the account is signing
 * into. `platformLogin` is one layer up: only a platform administrator comes
 * through it, and the session it opens is not narrowed to a tenant.
 */
export const authApi = {
  /**
   * `POST /auth/login` — answers the token pair plus the user profile.
   *
   * `tenant` is the tenant the door names. It is optional, because an account
   * whose name is unique across the platform may sign in without naming one.
   */
  login: (username: string, password: string, tenant?: string) =>
    apiPost<LoginResponse>(
      '/auth/login',
      tenant ? { username, password, tenant } : { username, password },
    ),

  /**
   * `POST /auth/platform-login` — the platform administrator's own door.
   *
   * A tenant administrator who tries it is refused with 403: the layer above
   * their tenant is not theirs to enter.
   */
  platformLogin: (username: string, password: string) =>
    apiPost<LoginResponse>('/auth/platform-login', { username, password }),

  /**
   * `GET /auth/tenants` — the tenant directory the login page offers.
   *
   * It is public: the page has to name a tenant before there is a session.
   */
  tenants: () => apiGet<TenantDirectoryResponse>('/auth/tenants'),

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
