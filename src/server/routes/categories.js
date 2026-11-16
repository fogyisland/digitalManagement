'use strict';

/**
 * Category routes.
 *
 * Contract (mirrored by `frontend/src/api/categories.ts`):
 *   GET    /categories     -> Category[]
 *   POST   /categories     {name, parent_id?, description?, sort_order?} -> Category
 *   PUT    /categories/:id {name?, parent_id?, description?, sort_order?} -> Category
 *   DELETE /categories/:id -> 204
 */

const express = require('express');
const { nanoid } = require('nanoid');
const { authRequired } = require('../lib/auth');
const { toCategory } = require('../lib/dto');
const { slugify, parsePositiveInt } = require('../lib/util');
const { isAllTenants, resolveWriteTenant } = require('../lib/tenant');
const { auditAction } = require('../lib/audit');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createCategoriesRouter({ db }) {
  const router = express.Router();

  router.get('/categories', authRequired(db), asyncHandler(async (req, res) => {
    const parentId = req.query.parent_id;
    const scope = req.tenantScope;
    const tenantId = scope.tenantId;
    // A platform administrator's scope covers every tenant, so their read
    // names no tenant at all. The two forms are written out rather than
    // assembled, because a condition built by concatenation cannot be
    // audited — and the tenant lint reads the SQL as text.
    let rows;
    if (isAllTenants(scope)) {
      if (parentId) {
        // tenant-lint: allow a superadmin reads across every tenant
        rows = await db
          .prepare('SELECT * FROM categories WHERE parent_id = ? ORDER BY sort_order, name')
          .all(String(parentId));
      } else {
        // tenant-lint: allow a superadmin reads across every tenant
        rows = await db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
      }
    } else {
      rows = parentId
        ? await db
            .prepare(
              'SELECT * FROM categories WHERE tenant_id = ? AND parent_id = ? ORDER BY sort_order, name',
            )
            .all(tenantId, String(parentId))
        : await db
            .prepare('SELECT * FROM categories WHERE tenant_id = ? ORDER BY sort_order, name')
            .all(tenantId);
    }
    return res.json(rows.map(toCategory));
  }));

  router.post('/categories', authRequired(db), asyncHandler(async (req, res) => {
    const { name, parent_id, description, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ detail: 'name required' });
    const id = nanoid();
    // A write lands in one concrete tenant — see `resolveWriteTenant`.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    try {
      await db
        .prepare(
          'INSERT INTO categories (id, tenant_id, name, slug, parent_id, description, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          tenantId,
          String(name),
          slugify(name),
          parent_id || null,
          description || null,
          parsePositiveInt(sort_order, 0, 1e6),
        );
    } catch (e) {
      return res.status(400).json({ detail: e.message });
    }
    const row = await db
      .prepare('SELECT * FROM categories WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId);
    await auditAction(db, req, {
      action: 'category.created',
      resourceType: 'category',
      resourceId: id,
      details: { name: String(name) },
    });
    return res.status(201).json(toCategory(row));
  }));

  router.put('/categories/:id', authRequired(db), asyncHandler(async (req, res) => {
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    const category = await db
      .prepare('SELECT * FROM categories WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!category) return res.status(404).json({ detail: 'Not found' });
    const { name, parent_id, description, sort_order } = req.body || {};
    await db
      .prepare(
        `UPDATE categories SET name = COALESCE(?, name), slug = COALESCE(?, slug), parent_id = ?,
         description = ?, sort_order = COALESCE(?, sort_order) WHERE id = ? AND tenant_id = ?`,
      )
      .run(
        name || null,
        name ? slugify(name) : null,
        parent_id !== undefined ? parent_id : category.parent_id,
        description !== undefined ? description : category.description,
        sort_order === undefined || sort_order === null ? null : parsePositiveInt(sort_order, 0, 1e6),
        category.id,
        tenantId,
      );
    const row = await db
      .prepare('SELECT * FROM categories WHERE id = ? AND tenant_id = ?')
      .get(category.id, tenantId);
    await auditAction(db, req, {
      action: 'category.updated',
      resourceType: 'category',
      resourceId: category.id,
      details: { name: row ? row.name : category.name },
    });
    return res.json(toCategory(row));
  }));

  router.delete('/categories/:id', authRequired(db), asyncHandler(async (req, res) => {
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    const category = await db
      .prepare('SELECT * FROM categories WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!category) return res.status(404).json({ detail: 'Not found' });
    // Detach the category from its assets and children instead of leaving
    // dangling references behind.
    await db
      .prepare('UPDATE assets SET category_id = NULL WHERE tenant_id = ? AND category_id = ?')
      .run(tenantId, category.id);
    await db
      .prepare('UPDATE categories SET parent_id = NULL WHERE tenant_id = ? AND parent_id = ?')
      .run(tenantId, category.id);
    await db
      .prepare('DELETE FROM categories WHERE id = ? AND tenant_id = ?')
      .run(category.id, tenantId);
    await auditAction(db, req, {
      action: 'category.deleted',
      resourceType: 'category',
      resourceId: category.id,
      details: { name: category.name },
    });
    return res.status(204).end();
  }));

  return router;
}

module.exports = createCategoriesRouter;
