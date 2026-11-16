import { apiDelete, apiGet, apiPost } from './client'
import type { McpScope, McpToken, McpTokenCreated, McpTokenListResponse } from '@/types'

/**
 * The MCP tokens — one per account per client.
 *
 * Contract (mirrored by `backend/src/routes/mcp-tokens.js`):
 *   GET    /mcp/tokens            -> {items: McpToken[]}
 *   POST   /mcp/tokens            {name?, scopes?} -> McpTokenCreated
 *   DELETE /mcp/tokens/:id        -> 204
 *
 * The token is the credential an AI client carries: it speaks for the account
 * that issued it, so it inherits that account's tenant and role. The clear
 * token is in the answer of the call that issues it and nowhere else — it is
 * stored hashed.
 */
export const mcpApi = {
  /** `GET /mcp/tokens` — the account's own tokens; an administrator sees their tenant's. */
  list: () => apiGet<McpTokenListResponse>('/mcp/tokens'),
  /** `POST /mcp/tokens` */
  create: (input: { name?: string; scopes?: McpScope[] }) =>
    apiPost<McpTokenCreated>('/mcp/tokens', input),
  /** `DELETE /mcp/tokens/:id` — the row is kept, switched off. */
  remove: (id: string) => apiDelete<void>(`/mcp/tokens/${id}`),
}
