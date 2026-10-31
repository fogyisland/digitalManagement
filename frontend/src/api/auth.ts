import { apiGet, apiPost } from './client'
import type { LoginResponse, User } from '@/types'

export const authApi = {
  login: (username: string, password: string) =>
    apiPost<LoginResponse>('/auth/login', { username, password }),

  refresh: (refresh_token: string) =>
    apiPost<{ access_token: string; expires_in: number }>('/auth/refresh', { refresh_token }),

  logout: () => apiPost('/auth/logout'),

  me: () => apiGet<User>('/auth/me'),

  changePassword: (old_password: string, new_password: string) =>
    apiPost('/auth/change-password', { old_password, new_password }),
}
