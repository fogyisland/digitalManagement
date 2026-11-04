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
 * Every delivery is signed and carries these headers:
 *
 *   X-DAM-Timestamp     Unix seconds, part of the signed material
 *   X-DAM-Signature     `sha256=` + HMAC-SHA256(secret, `${timestamp}.${body}`)
 *   X-DAM-Signature-V1  `sha256=` + HMAC-SHA256(secret, body)  [legacy]
 *   X-DAM-Event         the event name
 *   X-DAM-Attempt       the attempt number, 1..3
 *   X-DAM-Delivery      the `webhook_logs` id of this delivery
 *
 * Receivers should verify `X-DAM-Signature` against the raw body and reject a
 * timestamp more than a few minutes off their own clock — that is what stops
 * a captured delivery from being replayed. `X-DAM-Signature-V1` exists so a
 * receiver that has not been upgraded yet keeps verifying successfully; it
 * will be removed once every receiver checks the timestamp.
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
const { isAllTenants } = require('../lib/tenant');
const { asyncHandler } = require('../lib/http');

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
 * @param {object} db
 * @returns {import('express').Router}
 */
function createWebhooksRouter({ db }) {
  const router = express.Router();

  router.get('/webhooks', authRequired(db), asyncHandler(async (req, res) => {
    const scope = req.tenantScope;
    // tenant-lint: allow a superadmin reads across every tenant
    const rows = isAllTenants(scope)
      ? await db
          .prepare(
            'SELECT id, name, url, is_active, events, created_at FROM webhook_endpoints ORDER BY created_at DESC',
          )
          .all()
      : await db
          .prepare(
            'SELECT id, name, url, is_active, events, created_at FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC',
          )
          .all(scope.tenantId);
    return res.json(rows.map(toWebhook));
  }));

  router.post('/webhooks', authRequired(db), asyncHandler(async (req, res) => {
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
    // The endpoint belongs to the caller's tenant — its deliveries and its
    // log rows are that tenant's alone.
    await db
      .prepare(
        'INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret, events) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        req.tenantScope.tenantId,
        String(name).trim(),
        url,
        secret,
        normalized.events.join(','),
      );
    return res.status(201).json({
      id,
      name: String(name).trim(),
      url,
      secret,
      events: normalized.events,
      warning: 'Save this secret now. It will not be shown again.',
    });
  }));

  router.put('/webhooks/:id', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
    const endpoint = await db
      .prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
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

    await db
      .prepare(
        'UPDATE webhook_endpoints SET name = ?, url = ?, events = ?, is_active = ? WHERE id = ? AND tenant_id = ?',
      )
      .run(nextName, nextUrl, nextEvents, nextActive, endpoint.id, tenantId);

    const row = await db
      .prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?')
      .get(endpoint.id, tenantId);
    return res.json(toWebhook(row));
  }));

  router.delete('/webhooks/:id', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
    const endpoint = await db
      .prepare('SELECT id FROM webhook_endpoints WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!endpoint) return res.status(404).json({ detail: 'Not found' });
    // Soft-disable: keep the row for history + signature verification, but
    // stop emitting new events.
    await db
      .prepare('UPDATE webhook_endpoints SET is_active = 0 WHERE id = ? AND tenant_id = ?')
      .run(endpoint.id, tenantId);
    return res.status(204).end();
  }));

  return router;
}

module.exports = createWebhooksRouter;
