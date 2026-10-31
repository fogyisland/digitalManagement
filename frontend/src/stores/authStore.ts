import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'
import { authApi } from '@/api/auth'
import { getToken, getRefreshToken, setToken, setRefreshToken, isUnauthorized } from '@/api/client'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
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
 * login and reads them in the request interceptor. This store mirrors the
 * current values so the UI can render "logged in" state, but it never keeps
 * a second copy in `persist` — a duplicated token rots the moment the two
 * drift, and a stale token is worse than no token at all.
 *
 * `partialize` therefore persists the user profile only. On reload the
 * tokens are read straight back from `localStorage`, which is why
 * `bootstrapAuth()` below can restore a session without a re-login.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: getToken(),
      refreshToken: getRefreshToken(),
      setAuth: (user, access, refresh) => {
        setToken(access)
        setRefreshToken(refresh ?? null)
        set({ user, accessToken: access, refreshToken: refresh ?? null })
      },
      setUser: (user) => set({ user }),
      logout: () => {
        setToken(null)
        setRefreshToken(null)
        set({ user: null, accessToken: null, refreshToken: null })
      },
      hasRole: (...roles) => {
        const u = get().user
        return !!u && roles.includes(u.role)
      },
      canWrite: () => {
        const u = get().user
        return !!u && (u.role === 'admin' || u.role === 'editor')
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
 *    The backend answers with `{ id, username, role }` — a subset of `User` —
 *    so the fresh fields are merged over the persisted profile rather than
 *    replacing it (the persisted copy still holds `email`, `status`, …).
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
