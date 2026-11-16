'use strict';

/**
 * The MCP token routes.
 *
 * Contract (mirrored by `frontend/src/api/mcp.ts`):
 *   GET    /mcp/tokens            -> {items: McpToken[]}
 *   POST   /mcp/tokens            {name?, scopes?} -> McpTokenCreated (201)
 *   DELETE /mcp/tokens/:id        -> 204   (the row is kept, switched off)
 *
 * The tokens are the account's own: anybody may issue one for themselves,
 * because the token speaks for the account that issued it and can do nothing
 * that account cannot. An administrator sees the tokens of their tenant —
 * who holds a credential is worth knowing — and a platform administrator sees
 * all of them.
 *
 * The clear token is returned exactly once, when it is issued. It is stored
 * hashed, so it cannot be shown again.
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { toMcpToken } = require('../lib/dto');
const { SUPERADMIN_ROLE } = require('../lib/tenant');
const { issueMcpToken, listMcpTokens, revokeMcpToken } = require('../lib/mcp-tokens');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createMcpTokensRouter({ db }) {
  const router = express.Router();

  router.get(
    '/mcp/tokens',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const isAdmin = req.user.role === 'admin' || req.user.role === SUPERADMIN_ROLE;
      const rows = await listMcpTokens(db, req.user, isAdmin);
      return res.json({ items: rows.map(toMcpToken) });
    }),
  );

  router.post(
    '/mcp/tokens',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const { name, scopes } = req.body || {};
      const created = await issueMcpToken(db, req.user, { name, scopes });
      return res.status(201).json({
        ...toMcpToken(created),
        token: created.token,
        warning: 'Save this token now. It will not be shown again.',
      });
    }),
  );

  router.delete(
    '/mcp/tokens/:id',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const revoked = await revokeMcpToken(db, req.params.id, req.user.tenant_id, {
        // A platform administrator may cut off any token on the platform; the
        // rest may only cut off their own tenant's.
        crossTenant: req.user.role === SUPERADMIN_ROLE,
      });
      if (!revoked) return res.status(404).json({ detail: 'Not found' });
      return res.status(204).end();
    }),
  );

  return router;
}

module.exports = createMcpTokensRouter;
