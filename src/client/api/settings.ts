import { apiGet } from './client'
import type { InstanceSettings } from '@/types'

/**
 * The instance's own settings, as everybody sees them.
 *
 * Contract (mirrored by `backend/src/routes/settings.js`):
 *   GET /settings -> InstanceSettings
 *
 * Every signed-in account may read this: the interface shows the address the
 * instance answers at, so a link or an endpoint copied out of it works where
 * it is pasted. Changing it is the platform administrator's business, and
 * that happens through the platform console.
 */
export const settingsApi = {
  /** `GET /settings` — the address this instance answers at. */
  get: () => apiGet<InstanceSettings>('/settings'),
}
