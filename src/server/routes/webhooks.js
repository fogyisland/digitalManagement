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
const { isAllTenants, resolveWriteTenant } = require('../lib/tenant');
const { isPrivateHost, privateTargetsAllowed } = require('../lib/net');
const { asyncHandler } = require('../lib/http');

/**
 * Why an endpoint URL is not acceptable, or `null` when it is.
 *
 * The endpoint URL is the server's own outbound request, so it may not point
 * at an address only this server can reach. An address *literal* is judged
 * here; a name is judged where the request is actually made, because a name
 * that does not resolve yet is a name that has not been deployed yet — and
 * refusing it at registration time would refuse a perfectly good endpoint.
 *
 * @param {unknown} url
 * @returns {string|null} the reason, or null when the URL is acceptable
 */
function endpointUrlProblem(url) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return 'url must be http(s)';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return 'url is not a valid URL';
  }
  if (!privateTargetsAllowed() && isPrivateHost(parsed.hostname)) {
    return 'the endpoint URL must not point at a private or loopback address';
  }
  return null;
}

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
    const urlProblem = endpointUrlProblem(url);
    if (urlProblem) {
      return res.status(400).json({ code: 'BAD_INPUT', message: urlProblem, request_id: nanoid() });
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
    // log rows are that tenant's alone. A write lands in one concrete
    // tenant, so a platform administrator names it in `X-Tenant`.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    await db
      .prepare(
        'INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret, events) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        tenantId,
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
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
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
      const urlProblem = endpointUrlProblem(url);
      if (urlProblem) {
        return res
          .status(400)
          .json({ code: 'BAD_INPUT', message: urlProblem, request_id: nanoid() });
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
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
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
