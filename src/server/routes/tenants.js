'use strict';

/**
 * The tenant registry (platform administrators only).
 *
 * Contract:
 *   GET /tenants -> {items: Tenant[]}
 *
 * This is the list a platform administrator picks from when they decide which
 * tenant to act in: the header that narrows their request to one tenant
 * (`X-Tenant`) takes a tenant id, a slug or a name, and the UI offers them
 * the names.
 *
 * The list is deliberately **not** narrowed by `X-Tenant`. The whole point of
 * the list is to choose the tenant, so a request that already named one
 * would get a list of one.
 *
 * Only a platform administrator may read it. A tenant administrator who could
 * read it would learn the names of the tenants they share a platform with,
 * which is not their business.
 */

const express = require('express');
const { superadminRequired } = require('../lib/auth');
const { toTenant } = require('../lib/dto');
const { asyncHandler } = require('../lib/http');

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
      return res.json({ items: rows.map(toTenant) });
    }),
  );

  return router;
}

module.exports = createTenantsRouter;
