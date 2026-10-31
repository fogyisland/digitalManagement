import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { User, UserRole, UserStatus, PageResponse } from '@/types'

export const usersApi = {
  list: (params: { keyword?: string; role?: UserRole; status?: UserStatus; page?: number; page_size?: number } = {}) =>
    apiGet<PageResponse<User>>('/users', params),
  create: (payload: { username: string; email: string; password: string; display_name?: string; role: UserRole }) =>
    apiPost<User>('/users', payload),
  update: (id: number, payload: Partial<User>) => apiPut<User>(`/users/${id}`, payload),
  remove: (id: number) => apiDelete(`/users/${id}`),
  resetPassword: (id: number, new_password: string) =>
    apiPost(`/users/${id}/reset-password`, null, { params: { new_password } }),
}
