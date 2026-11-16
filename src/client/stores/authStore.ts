import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'
import { authApi } from '@/api/auth'
import { getToken, getRefreshToken, setToken, setRefreshToken, isUnauthorized } from '@/api/client'
import { clearTenantSelection } from './tenantStore'

interface AuthState {
  user: User | null
  setAuth: (user: User, access: string, refresh?: string | null) => void
  setUser: (user: User | null) => void
  logout: () => void
  hasRole: (...roles: string[]) => boolean
  canWrite: () => boolean
}

/**
 * Session store.
 *
 * ## Single source of truth for tokens
 *
 * The tokens live in `localStorage` under `dam_access_token` /
 * `dam_refresh_token`, and `api/client.ts` owns them: it writes them on
 * login, writes the **rotated** pair after a refresh, and reads them in the
 * request interceptor. This store deliberately keeps **no copy** of the
 * tokens — a duplicated token rots the moment the two drift, and the
 * interceptor cannot see a token written under a different key.
 *
 * `partialize` therefore persists the user profile only. On reload the
 * tokens are read straight back from `localStorage`, which is why
 * `bootstrapAuth()` below can restore a session without a re-login.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      setAuth: (user, access, refresh) => {
        setToken(access)
        setRefreshToken(refresh ?? null)
        // A platform administrator picks the tenant to act in; everybody else
        // has a tenant of their own, and a leftover selection from a previous
        // session is not theirs to keep.
        if (user.role !== 'superadmin') clearTenantSelection()
        set({ user })
      },
      setUser: (user) => set({ user }),
      /**
       * End the session.
       *
       * The tokens are revoked on the server first (the backend keeps a
       * `revoked_tokens` table, so the access token dies immediately instead
       * of lingering until its expiry). The local copy is cleared
       * unconditionally — a failed revocation must never leave a usable
       * token behind. The tenant selection goes with them: it belongs to the
       * session, not to the browser.
       */
      logout: () => {
        void authApi.logout().catch((error: unknown) => {
          console.warn('[auth] server-side logout failed, clearing local session anyway:', error)
        })
        setToken(null)
        setRefreshToken(null)
        clearTenantSelection()
        set({ user: null })
      },
      hasRole: (...roles) => {
        const u = get().user
        return !!u && roles.includes(u.role)
      },
      canWrite: () => {
        const u = get().user
        // A platform administrator writes too — inside the tenant they picked.
        return !!u && (u.role === 'admin' || u.role === 'editor' || u.role === 'superadmin')
      },
    }),
    {
      name: 'dam-auth',
      partialize: (s) => ({ user: s.user }),
    },
  ),
)

/**
 * Restore the session on boot.
 *
 * Called once from `main.tsx` before the first render finishes. It has three
 * jobs:
 *
 * 1. Drop a persisted user profile that has no token behind it. The profile
 *    survives a logout only if something wrote `dam-auth` without clearing
 *    the token; keeping it would render a "logged in" shell that fails every
 *    request.
 * 2. Confirm the stored token is still valid by calling `GET /auth/me`.
 *    The backend answers with the canonical user shape; the fresh fields are
 *    merged over the persisted profile so a role change made while the tab
 *    was closed is picked up.
 * 3. Sign the user out **only** when the server explicitly rejected the
 *    token (HTTP 401). A network failure or a 5xx must not end the
 *    session — that is a server problem, not an authentication problem.
 */
export async function bootstrapAuth(): Promise<void> {
  const state = useAuthStore.getState()
  const token = getToken()

  if (!token) {
    if (state.user) state.logout()
    return
  }

  try {
    const fresh = await authApi.me()
    const current = useAuthStore.getState().user
    useAuthStore.getState().setUser(current ? { ...current, ...fresh } : fresh)
  } catch (error: unknown) {
    if (isUnauthorized(error)) {
      useAuthStore.getState().logout()
      return
    }
    console.warn('[auth] session check failed, keeping the stored session:', error)
  }
}

/** The refresh token, read from the single source of truth. */
export function currentRefreshToken(): string | null {
  return getRefreshToken()
}
