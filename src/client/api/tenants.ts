import { apiGet } from './client'
import type { TenantListResponse } from '@/types'

/**
 * The tenant registry (platform administrators only).
 *
 * Contract (mirrored by `backend/src/routes/tenants.js`):
 *   GET /tenants -> {items: Tenant[]}
 *
 * The backend refuses this route for anybody who is not a platform
 * administrator, and it deliberately ignores `X-Tenant` here — the list is
 * what a platform administrator picks *from*, so a request that already named
 * a tenant would get a list of one.
 */
export const tenantsApi = {
  /** `GET /tenants` */
  list: () => apiGet<TenantListResponse>('/tenants'),
}
