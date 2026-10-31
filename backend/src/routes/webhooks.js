'use strict';

/**
 * Webhook endpoint routes (admin only).
 *
 * Contract (mirrored by `frontend/src/api/webhooks.ts`):
 *   GET    /webhooks     -> WebhookEndpoint[]
 *   POST   /webhooks     {name, url, events?} -> WebhookCreated
 *   PUT    /webhooks/:id {name?, url?, events?, is_active?} -> WebhookEndpoint
 *   DELETE /webhooks/:id -> 204   (soft disable — history is kept)
 *
 * The secret is shown exactly once, in the POST response.
 *
 * `events` is the subscription list. An empty list means "every event" —
 * that is the behaviour of every endpoint created before the column
 * existed, and it keeps the default safe. The vocabulary is fixed by
 * `WEBHOOK_EVENTS` in `backend/src/lib/webhook.js` and mirrored by
 * `WEBHOOK_EVENTS` in `frontend/src/api/webhooks.ts`.
 */

const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { authRequired } = require('../lib/auth');
const { toWebhook } = require('../lib/dto');
const { WEBHOOK_EVENTS } = require('../lib/webhook');

/**
 * Accept both an array and a CSV string; always return a clean,
 * de-duplicated list plus the entries outside the known vocabulary.
 *
 * An empty list is meaningful — it means "subscribe to everything" — so it
 * is returned as-is instead of falling back to a default list.
 *
 * @param {unknown} value
 * @returns {{events: string[], unknown: string[]}} the accepted events and
 *   the ones that are not part of the vocabulary (the caller answers 400)
 */
function normalizeEvents(value) {
  let raw;
  if (Array.isArray(value)) {
    raw = value.map((item) => String(item).trim());
  } else if (typeof value === 'string') {
    raw = value.split(',').map((item) => item.trim());
  } else if (value === undefined || value === null) {
    raw = [];
  } else {
    raw = [String(value).trim()];
  }

  const unique = [];
  for (const item of raw) {
    if (item.length > 0 && !unique.includes(item)) unique.push(item);
  }
  return {
    events: unique.filter((event) => WEBHOOK_EVENTS.includes(event)),
    unknown: unique.filter((event) => !WEBHOOK_EVENTS.includes(event)),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').Router}
 */
function createWebhooksRouter({ db }) {
  const router = express.Router();

  router.get('/webhooks', authRequired(db), (_req, res) => {
    const rows = db
      .prepare(
        'SELECT id, name, url, is_active, events, created_at FROM webhook_endpoints ORDER BY created_at DESC',
      )
      .all();
    return res.json(rows.map(toWebhook));
  });

  router.post('/webhooks', authRequired(db), (req, res) => {
    const { name, url, events } = req.body || {};
    if (!name || !url) {
      return res.status(400).json({ code: 'BAD_INPUT', message: 'name/url required', request_id: nanoid() });
    }
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return res.status(400).json({ code: 'BAD_INPUT', message: 'url must be http(s)', request_id: nanoid() });
    }
    const normalized = normalizeEvents(events);
    if (normalized.unknown.length) {
      return res.status(400).json({
        code: 'BAD_INPUT',
        message: `Unsupported events: ${normalized.unknown.join(', ')}`,
        request_id: nanoid(),
      });
    }
    const id = nanoid();
    const secret = crypto.randomBytes(24).toString('hex');
    db.prepare(
      'INSERT INTO webhook_endpoints (id, name, url, secret, events) VALUES (?, ?, ?, ?, ?)',
    ).run(id, String(name).trim(), url, secret, normalized.events.join(','));
    return res.status(201).json({
      id,
      name: String(name).trim(),
      url,
      secret,
      events: normalized.events,
      warning: 'Save this secret now. It will not be shown again.',
    });
  });

  router.put('/webhooks/:id', authRequired(db), (req, res) => {
    const endpoint = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(req.params.id);
    if (!endpoint) return res.status(404).json({ detail: 'Not found' });

    const { name, url, events, is_active } = req.body || {};

    let nextName = endpoint.name;
    if (name !== undefined && name !== null) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res
          .status(400)
          .json({ code: 'BAD_INPUT', message: 'name must not be empty', request_id: nanoid() });
      }
      nextName = trimmed;
    }

    let nextUrl = endpoint.url;
    if (url !== undefined && url !== null) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        return res
          .status(400)
          .json({ code: 'BAD_INPUT', message: 'url must be http(s)', request_id: nanoid() });
      }
      nextUrl = url;
    }

    let nextEvents = endpoint.events || '';
    if (events !== undefined && events !== null) {
      const normalized = normalizeEvents(events);
      if (normalized.unknown.length) {
        return res.status(400).json({
          code: 'BAD_INPUT',
          message: `Unsupported events: ${normalized.unknown.join(', ')}`,
          request_id: nanoid(),
        });
      }
      nextEvents = normalized.events.join(',');
    }

    let nextActive = endpoint.is_active;
    if (is_active !== undefined && is_active !== null) {
      nextActive = is_active ? 1 : 0;
    }

    db.prepare(
      'UPDATE webhook_endpoints SET name = ?, url = ?, events = ?, is_active = ? WHERE id = ?',
    ).run(nextName, nextUrl, nextEvents, nextActive, endpoint.id);

    const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(endpoint.id);
    return res.json(toWebhook(row));
  });

  router.delete('/webhooks/:id', authRequired(db), (req, res) => {
    const endpoint = db.prepare('SELECT id FROM webhook_endpoints WHERE id = ?').get(req.params.id);
    if (!endpoint) return res.status(404).json({ detail: 'Not found' });
    // Soft-disable: keep the row for history + signature verification, but
    // stop emitting new events.
    db.prepare('UPDATE webhook_endpoints SET is_active = 0 WHERE id = ?').run(endpoint.id);
    return res.status(204).end();
  });

  return router;
}

module.exports = createWebhooksRouter;
