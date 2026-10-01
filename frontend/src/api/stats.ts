import { apiGet } from './client'
import type { DashboardData } from '@/types'

export const statsApi = {
  dashboard: () => apiGet<DashboardData>('/api/v1/stats/dashboard'),
}
