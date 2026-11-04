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
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createCategoriesRouter({ db }) {
  const router = express.Router();

  router.get('/categories', authRequired(db), asyncHandler(async (req, res) => {
    const parentId = req.query.parent_id;
    const tenantId = req.tenantScope.tenantId;
    const rows = parentId
      ? await db
          .prepare(
            'SELECT * FROM categories WHERE tenant_id = ? AND parent_id = ? ORDER BY sort_order, name',
          )
          .all(tenantId, String(parentId))
      : await db
          .prepare('SELECT * FROM categories WHERE tenant_id = ? ORDER BY sort_order, name')
          .all(tenantId);
    return res.json(rows.map(toCategory));
  }));

  router.post('/categories', authRequired(db), asyncHandler(async (req, res) => {
    const { name, parent_id, description, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ detail: 'name required' });
    const id = nanoid();
    const tenantId = req.tenantScope.tenantId;
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
    return res.status(201).json(toCategory(row));
  }));

  router.put('/categories/:id', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
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
    return res.json(toCategory(row));
  }));

  router.delete('/categories/:id', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
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
    return res.status(204).end();
  }));

  return router;
}

module.exports = createCategoriesRouter;
