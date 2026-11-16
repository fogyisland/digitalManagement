import { apiGet, apiPut } from './client'
import type {
  PlatformAccount,
  PlatformAccountListResponse,
  PlatformAuditEntry,
  PlatformAuditListResponse,
  PlatformRequest,
  PlatformRequestListResponse,
  PlatformSettings,
  PlatformStats,
  PlatformTrafficReport,
} from '@/types'

/**
 * The platform layer's API.
 *
 * Contract (mirrored by `backend/src/routes/platform.js`):
 *   GET  /platform/stats          -> PlatformStats
 *   GET  /platform/accounts       -> PlatformAccountListResponse
 *   PUT  /platform/accounts/:id   {role?, tenant_id?, status?} -> PlatformAccount
 *   GET  /platform/audit          -> PlatformAuditListResponse
 *   GET  /platform/requests       -> PlatformRequestListResponse
 *   GET  /platform/traffic        -> PlatformTrafficReport
 *
 * These routes answer for the platform itself — the layer above the tenants —
 * so the backend reserves them for platform administrators.
 */
export const platformApi = {
  /** `GET /platform/stats` — what the platform holds. */
  stats: () => apiGet<PlatformStats>('/platform/stats'),

  /** `GET /platform/accounts` — every account on the platform. */
  accounts: (params?: { keyword?: string; role?: string; status?: string }) =>
    apiGet<PlatformAccountListResponse>('/platform/accounts', params),

  /**
   * `PUT /platform/accounts/:id` — move an account.
   *
   * A role of `superadmin` puts the account on the wildcard tenant; any other
   * role needs a tenant to sit in. Changing either ends the account's
   * sessions: a token carries the role it was signed with.
   */
  updateAccount: (id: string, change: { role?: string; tenant_id?: string; status?: string }) =>
    apiPut<PlatformAccount>(`/platform/accounts/${id}`, change),

  /** `GET /platform/audit` — what the platform layer did. */
  audit: (limit?: number) =>
    apiGet<PlatformAuditListResponse>('/platform/audit', limit ? { limit } : undefined),

  /**
   * `GET /platform/requests` — the traffic log, newest first.
   *
   * The log spans every tenant; `tenantId` narrows it to one. `statusClass` is
   * `2xx`, `4xx` or `5xx`, and `hours` says how far back to look.
   */
  requests: (params?: {
    tenantId?: string
    keyword?: string
    method?: string
    statusClass?: string
    hours?: number
    limit?: number
    offset?: number
  }) =>
    apiGet<PlatformRequestListResponse>(
      '/platform/requests',
      params
        ? {
            tenant_id: params.tenantId,
            keyword: params.keyword,
            method: params.method,
            status_class: params.statusClass,
            hours: params.hours,
            limit: params.limit,
            offset: params.offset,
          }
        : undefined,
    ),

  /** `GET /platform/traffic` — the same traffic, counted. */
  traffic: (params?: { tenantId?: string; hours?: number; buckets?: number }) =>
    apiGet<PlatformTrafficReport>(
      '/platform/traffic',
      params
        ? { tenant_id: params.tenantId, hours: params.hours, buckets: params.buckets }
        : undefined,
    ),

  /** `GET /platform/settings` — the instance's own settings. */
  settings: () => apiGet<PlatformSettings>('/platform/settings'),

  /**
   * `PUT /platform/settings` — change them.
   *
   * The address and the cross-origin list take effect as soon as this returns;
   * neither needs a restart.
   */
  saveSettings: (change: { access_domain?: string; cors_origins?: string[] }) =>
    apiPut<PlatformSettings>('/platform/settings', change),
}
