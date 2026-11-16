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
      // The scope decides how far the list reaches — a platform administrator
      // who named a tenant sees that tenant's tokens, not every tenant's.
      const rows = await listMcpTokens(db, req.user, req.tenantScope, isAdmin);
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
      const revoked = await revokeMcpToken(db, req.params.id, {
        // The scope decides how far the revocation reaches, and the role
        // decides whose credential it may be: a platform administrator may
        // cut off any token of the tenant the request speaks for, an
        // administrator any token of their own tenant, and everybody else
        // only their own.
        scope: req.tenantScope,
        userId: req.user.id,
        isAdmin: req.user.role === 'admin' || req.user.role === SUPERADMIN_ROLE,
      });
      if (!revoked) return res.status(404).json({ detail: 'Not found' });
      return res.status(204).end();
    }),
  );

  return router;
}

module.exports = createMcpTokensRouter;
