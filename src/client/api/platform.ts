import { apiGet, apiPut } from './client'
import type {
  PlatformAccount,
  PlatformAccountListResponse,
  PlatformAuditEntry,
  PlatformAuditListResponse,
  PlatformStats,
} from '@/types'

/**
 * The platform layer's API.
 *
 * Contract (mirrored by `backend/src/routes/platform.js`):
 *   GET  /platform/stats          -> PlatformStats
 *   GET  /platform/accounts       -> PlatformAccountListResponse
 *   PUT  /platform/accounts/:id   {role?, tenant_id?, status?} -> PlatformAccount
 *   GET  /platform/audit          -> PlatformAuditListResponse
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
}
