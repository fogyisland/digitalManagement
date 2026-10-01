import { apiGet, apiPost } from './client'
import type { LoginResponse, User } from '@/types'

export const authApi = {
  login: (username: string, password: string) =>
    apiPost<LoginResponse>('/api/v1/auth/login', { username, password }),

  refresh: (refresh_token: string) =>
    apiPost<{ access_token: string; expires_in: number }>('/api/v1/auth/refresh', { refresh_token }),

  logout: () => apiPost('/api/v1/auth/logout'),

  me: () => apiGet<User>('/api/v1/auth/me'),

  changePassword: (old_password: string, new_password: string) =>
    apiPost('/api/v1/auth/change-password', { old_password, new_password }),
}
