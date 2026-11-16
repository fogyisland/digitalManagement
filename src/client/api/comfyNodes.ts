import { apiGet } from './client'
import type { ComfyNode } from '@/types'

/**
 * ComfyUI 节点 API surface.
 *
 * Contract (mirrored by `backend/src/routes/comfy-nodes.js`):
 *   GET /comfy-nodes -> ComfyNode[]
 *
 * 节点不是平台发出去的，而是节点自己登记的：它带着自己的 API Key 敲
 * `/api/ingest/v1/nodes/register`，平台据此知道这台 ComfyUI 存在、叫什么、
 * 多久没开口了。这个接口只是读的那一侧。
 */
export const comfyNodesApi = {
  /** 平台不翻页——一台 ComfyUI 就是一行，这个列表不会长到需要翻页。 */
  list: () => apiGet<ComfyNode[]>('/comfy-nodes'),
}
