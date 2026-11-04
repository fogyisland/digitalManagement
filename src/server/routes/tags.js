'use strict';

/**
 * Tag routes.
 *
 * Contract (mirrored by `frontend/src/api/tags.ts`):
 *   GET    /tags     -> Tag[]
 *   POST   /tags     {name, color?, description?} -> Tag
 *   PUT    /tags/:id {name?, color?, description?} -> Tag
 *   DELETE /tags/:id -> 204
 *
 * A platform administrator's scope covers every tenant, so the reads here
 * have two statements — one that names the tenant and one that does not.
 * The two statements are written out rather than assembled at runtime,
 * because the tenant lint reads the SQL as text.
 */

const express = require('express');
const { nanoid } = require('nanoid');
const { authRequired } = require('../lib/auth');
const { toTag } = require('../lib/dto');
const { slugify } = require('../lib/util');
const { isAllTenants } = require('../lib/tenant');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createTagsRouter({ db }) {
  const router = express.Router();

  router.get('/tags', authRequired(db), asyncHandler(async (req, res) => {
    const scope = req.tenantScope;
    // tenant-lint: allow a superadmin reads across every tenant
    const rows = isAllTenants(scope)
      ? await db.prepare('SELECT * FROM tags ORDER BY usage_count DESC, name').all()
      : await db
          .prepare('SELECT * FROM tags WHERE tenant_id = ? ORDER BY usage_count DESC, name')
          .all(scope.tenantId);
    return res.json(rows.map(toTag));
  }));

  router.post('/tags', authRequired(db), asyncHandler(async (req, res) => {
    const { name, color, description } = req.body || {};
    if (!name) return res.status(400).json({ detail: 'name required' });
    const id = nanoid();
    const tenantId = req.tenantScope.tenantId;
    try {
      await db
        .prepare('INSERT INTO tags (id, tenant_id, name, slug, color) VALUES (?, ?, ?, ?, ?)')
        .run(id, tenantId, String(name), slugify(name), color || null);
    } catch (e) {
      return res.status(400).json({ detail: e.message });
    }
    const row = await db
      .prepare('SELECT * FROM tags WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId);
    return res.status(201).json(toTag(row));
  }));

  router.put('/tags/:id', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
    const tag = await db
      .prepare('SELECT * FROM tags WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!tag) return res.status(404).json({ detail: 'Not found' });
    const { name, color } = req.body || {};
    if (name !== undefined && name !== null && String(name) !== tag.name) {
      try {
        await db
          .prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ? AND tenant_id = ?')
          .run(String(name), slugify(name), tag.id, tenantId);
      } catch (e) {
        return res.status(400).json({ detail: e.message });
      }
    }
    if (color !== undefined) {
      await db
        .prepare('UPDATE tags SET color = ? WHERE id = ? AND tenant_id = ?')
        .run(color || null, tag.id, tenantId);
    }
    const row = await db
      .prepare('SELECT * FROM tags WHERE id = ? AND tenant_id = ?')
      .get(tag.id, tenantId);
    return res.json(toTag(row));
  }));

  router.delete('/tags/:id', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
    const tag = await db
      .prepare('SELECT * FROM tags WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!tag) return res.status(404).json({ detail: 'Not found' });
    await db
      .prepare('DELETE FROM asset_tags WHERE tenant_id = ? AND tag_id = ?')
      .run(tenantId, tag.id);
    await db.prepare('DELETE FROM tags WHERE id = ? AND tenant_id = ?').run(tag.id, tenantId);
    return res.status(204).end();
  }));

  return router;
}

module.exports = createTagsRouter;
