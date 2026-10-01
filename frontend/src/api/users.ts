import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { User, UserRole, UserStatus, PageResponse } from '@/types'

export const usersApi = {
  list: (params: { keyword?: string; role?: UserRole; status?: UserStatus; page?: number; page_size?: number } = {}) =>
    apiGet<PageResponse<User>>('/api/v1/users', params),
  create: (payload: { username: string; email: string; password: string; display_name?: string; role: UserRole }) =>
    apiPost<User>('/api/v1/users', payload),
  update: (id: number, payload: Partial<User>) => apiPatch<User>(`/api/v1/users/${id}`, payload),
  remove: (id: number) => apiDelete(`/api/v1/users/${id}`),
  resetPassword: (id: number, new_password: string) =>
    apiPost(`/api/v1/users/${id}/reset-password`, null, { params: { new_password } }),
}
