import { apiGet } from './client'
import type { AuditListResponse } from '@/types'

/**
 * The audit trail — the tenant's own record of what its people changed.
 *
 * Contract (mirrored by `backend/src/routes/audit.js`):
 *   GET /audit -> {items: AuditEntry[]}
 *
 * The trail follows the scope of the request: an administrator reads their
 * tenant's trail, everybody else reads their own actions. The platform layer's
 * own actions are recorded against the wildcard tenant and are read in the
 * platform console.
 */
export const auditApi = {
  /** `GET /audit` — the trail of the tenant this request speaks for. */
  list: (limit?: number) => apiGet<AuditListResponse>('/audit', { limit }),
}
