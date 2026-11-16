import { apiDelete, apiGet, apiPost, apiPut } from './client'
import type { Tenant, TenantInput, TenantListResponse } from '@/types'

/**
 * The tenant registry (platform administrators only).
 *
 * Contract (mirrored by `backend/src/routes/tenants.js`):
 *   GET    /tenants        -> {items: Tenant[]}
 *   POST   /tenants        {name, slug?, id?, status?} -> Tenant
 *   PUT    /tenants/:id    {name?, slug?, status?} -> Tenant
 *   DELETE /tenants/:id    -> {tenant, removed}
 *
 * The backend refuses these routes for anybody who is not a platform
 * administrator, and it deliberately ignores `X-Tenant` on the list — the list
 * is what a platform administrator picks *from*, so a request that already
 * named a tenant would get a list of one.
 */
export const tenantsApi = {
  /** `GET /tenants` */
  list: () => apiGet<TenantListResponse>('/tenants'),
  /** `POST /tenants` */
  create: (input: TenantInput) => apiPost<Tenant>('/tenants', input),
  /** `PUT /tenants/:id` */
  update: (id: string, input: Partial<TenantInput>) => apiPut<Tenant>(`/tenants/${id}`, input),
  /** `DELETE /tenants/:id` — the tenant and everything inside it. */
  remove: (id: string) =>
    apiDelete<{ tenant: Tenant; removed: Record<string, number> }>(`/tenants/${id}`),
}
