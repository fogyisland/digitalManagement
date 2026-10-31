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

/**
 * @param {{db: import('better-sqlite3').Database}} deps
 * @returns {import('express').Router}
 */
function createCategoriesRouter({ db }) {
  const router = express.Router();

  router.get('/categories', (req, res) => {
    const parentId = req.query.parent_id;
    const rows = parentId
      ? db
          .prepare('SELECT * FROM categories WHERE parent_id = ? ORDER BY sort_order, name')
          .all(String(parentId))
      : db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
    return res.json(rows.map(toCategory));
  });

  router.post('/categories', authRequired(db), (req, res) => {
    const { name, parent_id, description, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ detail: 'name required' });
    const id = nanoid();
    try {
      db.prepare(
        'INSERT INTO categories (id, name, slug, parent_id, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        String(name),
        slugify(name),
        parent_id || null,
        description || null,
        parsePositiveInt(sort_order, 0, 1e6),
      );
    } catch (e) {
      return res.status(400).json({ detail: e.message });
    }
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    return res.status(201).json(toCategory(row));
  });

  router.put('/categories/:id', authRequired(db), (req, res) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!category) return res.status(404).json({ detail: 'Not found' });
    const { name, parent_id, description, sort_order } = req.body || {};
    db.prepare(
      `UPDATE categories SET name = COALESCE(?, name), slug = COALESCE(?, slug), parent_id = ?,
         description = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?`,
    ).run(
      name || null,
      name ? slugify(name) : null,
      parent_id !== undefined ? parent_id : category.parent_id,
      description !== undefined ? description : category.description,
      sort_order === undefined || sort_order === null ? null : parsePositiveInt(sort_order, 0, 1e6),
      category.id,
    );
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(category.id);
    return res.json(toCategory(row));
  });

  router.delete('/categories/:id', authRequired(db), (req, res) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!category) return res.status(404).json({ detail: 'Not found' });
    // Detach the category from its assets and children instead of leaving
    // dangling references behind.
    db.prepare('UPDATE assets SET category_id = NULL WHERE category_id = ?').run(category.id);
    db.prepare('UPDATE categories SET parent_id = NULL WHERE parent_id = ?').run(category.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
    return res.status(204).end();
  });

  return router;
}

module.exports = createCategoriesRouter;
