import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'
import { authApi } from '@/api/auth'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  setAuth: (user: User, access: string, refresh: string) => void
  setUser: (user: User | null) => void
  logout: () => void
  hasRole: (...roles: string[]) => boolean
  canWrite: () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setAuth: (user, access, refresh) => {
        localStorage.setItem('dam_access_token', access)
        localStorage.setItem('dam_refresh_token', refresh)
        set({ user, accessToken: access, refreshToken: refresh })
      },
      setUser: (user) => set({ user }),
      logout: () => {
        localStorage.removeItem('dam_access_token')
        localStorage.removeItem('dam_refresh_token')
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

// Bootstrap: rehydrate tokens to localStorage if present
export async function bootstrapAuth(): Promise<void> {
  const state = useAuthStore.getState()
  if (state.accessToken) {
    localStorage.setItem('dam_access_token', state.accessToken)
  }
  if (state.refreshToken) {
    localStorage.setItem('dam_refresh_token', state.refreshToken)
  }
  if (state.user) {
    try {
      const fresh = await authApi.me()
      useAuthStore.getState().setUser(fresh)
    } catch {
      useAuthStore.getState().logout()
    }
  }
}
