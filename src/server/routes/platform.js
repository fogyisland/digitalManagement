'use strict';

/**
 * The platform layer's own API.
 *
 * Contract:
 *   GET  /platform/stats          -> PlatformStats
 *   GET  /platform/accounts       -> {items: PlatformAccount[], total: number}
 *   PUT  /platform/accounts/:id   {role?, tenant_id?, status?} -> PlatformAccount
 *   GET  /platform/audit          -> {items: PlatformAuditEntry[]}
 *   GET  /platform/requests       -> {items: PlatformRequest[], total: number}
 *   GET  /platform/traffic        -> {summary, buckets, routes}
 *   GET  /platform/settings       -> PlatformSettings
 *   PUT  /platform/settings       {access_domain?, cors_origins?} -> PlatformSettings
 *
 * `PUT /platform/settings` changes only the fields it is given: an empty
 * string clears the address, an empty list clears the cross-origin list, and a
 * field that is not mentioned keeps its value.
 *
 * Every route here is for the platform administrator alone. This is the layer
 * *above* the tenants, so it answers for the platform itself: how much the
 * platform holds, who holds an account on it, what the platform layer did, and
 * what the platform was asked to do.
 */

const express = require('express');
const { superadminRequired, revokeUserSessions } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const { listRequests, trafficReport } = require('../lib/request-log-report');
const { readSettings, saveSettings } = require('../lib/platform-settings');
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

  // The traffic: the request log itself, newest first.
  //
  // The log spans every tenant, so the platform reads it whole — and may
  // narrow it to one tenant when it is looking for what one of them is doing.
  router.get(
    '/platform/requests',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const result = await listRequests(db, {
        tenantId: req.query.tenant_id,
        keyword: req.query.keyword,
        method: req.query.method,
        statusClass: req.query.status_class,
        hours: req.query.hours,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return res.json(result);
    }),
  );

  // The same traffic, counted: the totals over a window, the shape over time,
  // and the endpoints that carry it.
  router.get(
    '/platform/traffic',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const report = await trafficReport(db, {
        tenantId: req.query.tenant_id,
        hours: req.query.hours,
        buckets: req.query.buckets,
      });
      return res.json(report);
    }),
  );

  // The instance's own settings: the address it is reached at and the origins
  // allowed to call it. The platform administrator is the only one who may
  // change them — the address is what every link the instance hands out is
  // built from, and the allow-list is what says who may call it.
  router.get(
    '/platform/settings',
    superadminRequired(db),
    asyncHandler(async (_req, res) => {
      return res.json(await readSettings(db));
    }),
  );

  router.put(
    '/platform/settings',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const saved = await saveSettings(db, req.body || {}, { userId: req.user.id });
      await writeAudit(db, {
        action: 'platform.settings.updated',
        resourceType: 'platform_settings',
        resourceId: 'platform',
        details: {
          access_domain: saved.access_domain,
          cors_origins: saved.cors_origins.join(', '),
        },
        userId: req.user.id,
        ip: req.ip,
      });
      return res.json(saved);
    }),
  );

  return router;
}

module.exports = createPlatformRouter;
