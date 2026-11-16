'use strict';

/**
 * The audit trail of the tenant this request speaks for.
 *
 * Contract (mirrored by `frontend/src/api/audit.ts`):
 *   GET /audit -> {items: AuditEntry[]}
 *
 * The scope decides how far the trail reaches, exactly as it decides how far
 * every other read reaches:
 *
 *   - a tenant administrator reads their own tenant's trail
 *   - a platform administrator who named a tenant reads that tenant's trail
 *   - a platform administrator who named none reads the whole platform's
 *   - everybody else reads their own actions
 *
 * The platform layer's own actions — a tenant created, an account moved — are
 * recorded against the wildcard, so they belong to the platform and not to any
 * tenant. The platform console reads them in its own audit tab.
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { listAudit } = require('../lib/audit');
const { SUPERADMIN_ROLE, ALL_TENANTS } = require('../lib/tenant');
const { parsePositiveInt } = require('../lib/util');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createAuditRouter({ db }) {
  const router = express.Router();

  router.get('/audit', authRequired(db), asyncHandler(async (req, res) => {
    const scope = req.tenantScope;
    const isAdmin = req.user.role === 'admin' || req.user.role === SUPERADMIN_ROLE;
    const items = await listAudit(db, {
      tenantId: scope.tenantId,
      // A scope that reaches every tenant wants the whole platform's trail;
      // a narrowed one wants that tenant's.
      allTenants: scope.tenantId === ALL_TENANTS,
      // A member of the tenant reads their own actions; an administrator
      // reads the tenant's.
      userId: isAdmin ? null : req.user.id,
      limit: parsePositiveInt(req.query.limit, 100, 500),
    });
    return res.json({ items });
  }));

  return router;
}

module.exports = createAuditRouter;
