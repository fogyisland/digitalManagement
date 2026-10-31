'use strict';

/**
 * Tag routes.
 *
 * Contract (mirrored by `frontend/src/api/tags.ts`):
 *   GET    /tags     -> Tag[]
 *   POST   /tags     {name, color?, description?} -> Tag
 *   PUT    /tags/:id {name?, color?, description?} -> Tag
 *   DELETE /tags/:id -> 204
 */

const express = require('express');
const { nanoid } = require('nanoid');
const { authRequired } = require('../lib/auth');
const { toTag } = require('../lib/dto');
const { slugify } = require('../lib/util');

/**
 * @param {{db: import('better-sqlite3').Database}} deps
 * @returns {import('express').Router}
 */
function createTagsRouter({ db }) {
  const router = express.Router();

  router.get('/tags', (_req, res) => {
    const rows = db.prepare('SELECT * FROM tags ORDER BY usage_count DESC, name').all();
    return res.json(rows.map(toTag));
  });

  router.post('/tags', authRequired(db), (req, res) => {
    const { name, color, description } = req.body || {};
    if (!name) return res.status(400).json({ detail: 'name required' });
    const id = nanoid();
    try {
      db.prepare('INSERT INTO tags (id, name, slug, color) VALUES (?, ?, ?, ?)').run(
        id,
        String(name),
        slugify(name),
        color || null,
      );
    } catch (e) {
      return res.status(400).json({ detail: e.message });
    }
    const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    return res.status(201).json(toTag(row));
  });

  router.put('/tags/:id', authRequired(db), (req, res) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    if (!tag) return res.status(404).json({ detail: 'Not found' });
    const { name, color } = req.body || {};
    if (name !== undefined && name !== null && String(name) !== tag.name) {
      try {
        db.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').run(
          String(name),
          slugify(name),
          tag.id,
        );
      } catch (e) {
        return res.status(400).json({ detail: e.message });
      }
    }
    if (color !== undefined) {
      db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color || null, tag.id);
    }
    const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);
    return res.json(toTag(row));
  });

  router.delete('/tags/:id', authRequired(db), (req, res) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
    if (!tag) return res.status(404).json({ detail: 'Not found' });
    db.prepare('DELETE FROM asset_tags WHERE tag_id = ?').run(tag.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    return res.status(204).end();
  });

  return router;
}

module.exports = createTagsRouter;
