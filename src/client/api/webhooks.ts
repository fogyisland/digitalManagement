import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { WebhookCreated, WebhookEndpoint, WebhookEvent, WebhookUpdatePayload } from '@/types'

/**
 * The event vocabulary the backend accepts (`WEBHOOK_EVENTS` in
 * `backend/src/lib/webhook.js`).
 *
 * The list must stay identical to the backend's: the backend answers 400 for
 * an event it does not know, so a frontend-only event would be a dead
 * subscription the user could never fix.
 */
export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'asset.created',
  'asset.updated',
  'asset.deleted',
  'asset.restored',
  'asset.metadata_updated',
  'tenant.created',
  'tenant.updated',
]

/** Human labels for the event checkboxes. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  'asset.created': '资产新建',
  'asset.updated': '资产更新',
  'asset.deleted': '资产删除',
  'asset.restored': '资产恢复',
  'asset.metadata_updated': '资产元数据更新',
  'tenant.created': '租户新建',
  'tenant.updated': '租户更新',
}

/**
 * Webhook API surface.
 *
 * Contract (mirrored by `backend/src/routes/webhooks.js`):
 *   GET    /webhooks     -> WebhookEndpoint[]
 *   POST   /webhooks     {name, url, events?} -> WebhookCreated
 *   PUT    /webhooks/:id {name?, url?, events?, is_active?} -> WebhookEndpoint
 *   DELETE /webhooks/:id -> 204   (soft disable — the row is kept for audit)
 *
 * `events` is the subscription list. An **empty list means "every event"** —
 * that is the backend's semantic, not a frontend invention, so the UI must
 * not treat "no box ticked" as "no events".
 */
export const webhooksApi = {
  /** The backend serves the full endpoint list; it is not paginated. */
  list: () => apiGet<WebhookEndpoint[]>('/webhooks'),

  /**
   * `POST /webhooks`
   *
   * The secret is returned exactly once — the response field is `secret`,
   * and it is never readable again afterwards.
   */
  create: (payload: { name: string; url: string; events?: WebhookEvent[] }) =>
    apiPost<WebhookCreated>('/webhooks', payload),

  /** `PUT /webhooks/:id` — `is_active: true` re-enables a disabled endpoint. */
  update: (id: string, payload: WebhookUpdatePayload) =>
    apiPut<WebhookEndpoint>(`/webhooks/${id}`, payload),

  /** `DELETE /webhooks/:id` — deactivates the endpoint without deleting its row. */
  remove: (id: string) => apiDelete<void>(`/webhooks/${id}`),
}
