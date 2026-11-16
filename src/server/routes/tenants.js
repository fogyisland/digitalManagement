'use strict';

/**
 * The tenant registry (platform administrators only).
 *
 * Contract:
 *   GET    /tenants          -> {items: Tenant[]}
 *   POST   /tenants          {name, slug?, id?, status?} -> Tenant (201)
 *   PUT    /tenants/:id      {name?, slug?, status?} -> Tenant
 *   DELETE /tenants/:id      -> {tenant, removed}
 *
 * This is the list a platform administrator picks from when they decide which
 * tenant to act in: the header that narrows their request to one tenant
 * (`X-Tenant`) takes a tenant id, a slug or a name, and the UI offers them
 * the names.
 *
 * The list is deliberately **not** narrowed by `X-Tenant`. The whole point of
 * the list is to choose the tenant, so a request that already named one would
 * get a list of one.
 *
 * Only a platform administrator may read it. A tenant administrator who could
 * read it would learn the names of the tenants they share a platform with,
 * which is not their business.
 *
 * The writes are the other half of the model: the platform administrator is
 * the one who decides how many tenants there are and what they are called.
 * Everything they hold — the assets, the users, the keys — belongs to a
 * tenant, so a tenant is created before there is anything to put in it, and a
 * tenant that goes away takes its contents with it.
 */

const express = require('express');
const { getConfig } = require('../config');
const { superadminRequired } = require('../lib/auth');
const { toTenant } = require('../lib/dto');
const { asyncHandler } = require('../lib/http');
const { writeAudit } = require('../lib/platform');
const {
  createTenant,
  updateTenant,
  deleteTenant,
  tenantCounts,
} = require('../lib/tenant-registry');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createTenantsRouter({ db }) {
  const router = express.Router();

  router.get(
    '/tenants',
    superadminRequired(db),
    asyncHandler(async (_req, res) => {
      const rows = await db
        .prepare(
          'SELECT id, name, slug, status, created_at FROM tenants ORDER BY created_at ASC, name ASC',
        )
        .all();
      // The counts are what the platform administrator looks at before they
      // suspend or remove a tenant, so the list carries them.
      const items = [];
      for (const row of rows) {
        const counts = await tenantCounts(db, row.id);
        items.push(toTenant({ ...row, ...counts }));
      }
      return res.json({ items });
    }),
  );

  router.post(
    '/tenants',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const created = await createTenant(db, req.body || {});
      const counts = await tenantCounts(db, created.id);
      await writeAudit(db, {
        action: 'platform.tenant.created',
        resourceType: 'tenant',
        resourceId: created.id,
        details: { name: created.name, slug: created.slug },
        userId: req.user.id,
        ip: req.ip,
      });
      return res.status(201).json(toTenant({ ...created, ...counts }));
    }),
  );

  router.put(
    '/tenants/:id',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const updated = await updateTenant(db, req.params.id, req.body || {});
      const counts = await tenantCounts(db, updated.id);
      await writeAudit(db, {
        action: 'platform.tenant.updated',
        resourceType: 'tenant',
        resourceId: updated.id,
        details: { name: updated.name, slug: updated.slug, status: updated.status },
        userId: req.user.id,
        ip: req.ip,
      });
      return res.json(toTenant({ ...updated, ...counts }));
    }),
  );

  router.delete(
    '/tenants/:id',
    superadminRequired(db),
    asyncHandler(async (req, res) => {
      const result = await deleteTenant(db, req.params.id, {
        storageDir: getConfig().storageDir,
      });
      await writeAudit(db, {
        action: 'platform.tenant.deleted',
        resourceType: 'tenant',
        resourceId: result.tenant.id,
        details: { name: result.tenant.name, removed: result.removed },
        userId: req.user.id,
        ip: req.ip,
      });
      return res.json({
        tenant: toTenant(result.tenant),
        removed: result.removed,
        detail:
          `The tenant "${result.tenant.name}" and everything inside it are gone. ` +
          'This cannot be undone.',
      });
    }),
  );

  return router;
}

module.exports = createTenantsRouter;
