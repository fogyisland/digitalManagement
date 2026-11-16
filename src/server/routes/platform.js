'use strict';

/**
 * The platform layer's own API.
 *
 * Contract:
 *   GET  /platform/stats          -> PlatformStats
 *   GET  /platform/accounts       -> {items: PlatformAccount[], total: number}
 *   PUT  /platform/accounts/:id   {role?, tenant_id?, status?} -> PlatformAccount
 *   GET  /platform/audit          -> {items: PlatformAuditEntry[]}
 *
 * Every route here is for the platform administrator alone. This is the layer
 * *above* the tenants, so it answers for the platform itself: how much the
 * platform holds, who holds an account on it, and what the platform layer did.
 */

const express = require('express');
const { superadminRequired, revokeUserSessions } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const {
  platformStats,
  listAccounts,
  updateAccount,
  writeAudit,
  listAudit,
} = require('../lib/platform');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createPlatformRouter({ db }) {
  const router = express.Router();

  // What the platform holds: tenants, accounts, assets, storage.
  router.get(
    '/platform/stats',
    superadminRequired(db),
    asyncHandler(async (_req, res) => {
      return res.json(await platformStats(db));
    }),
  );

  // Every account on the platform, whichever tenant it belongs to.
  router.get(
    '/platform/accounts',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const result = await listAccounts(db, {
        keyword: req.query.keyword,
        role: req.query.role,
        status: req.query.status,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return res.json(result);
    }),
  );

  // Move an account: another role, another tenant, or switched off.
  //
  // A token carries the role and the tenant it was signed with, so the
  // account's sessions end with the change — a credential that outlives the
  // role it was issued under is one the platform cannot take back.
  router.put(
    '/platform/accounts/:id',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const updated = await updateAccount(db, req.params.id, req.body || {});
      await revokeUserSessions(db, updated.id);
      await writeAudit(db, {
        action: 'platform.account.updated',
        resourceType: 'user',
        resourceId: updated.id,
        details: {
          username: updated.username,
          role: updated.role,
          tenant_id: updated.tenant_id,
          status: updated.status,
        },
        userId: req.user.id,
        ip: req.ip,
      });
      return res.json(updated);
    }),
  );

  // What the platform layer did.
  router.get(
    '/platform/audit',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      return res.json({ items: await listAudit(db, { limit: req.query.limit }) });
    }),
  );

  return router;
}

module.exports = createPlatformRouter;
