'use strict';

/**
 * User management routes (admin only).
 *
 * Contract (mirrored by `frontend/src/api/users.ts`):
 *   GET    /users                ?keyword=&role=&status=&page=&page_size= -> PageResponse<User>
 *   POST   /users                {username, email, password, display_name?, role} -> User
 *   PUT    /users/:id            {email?, display_name?, role?, status?}  -> User
 *   DELETE /users/:id                                                 -> 204
 *   POST   /users/:id/reset-password  {new_password}                  -> 204
 *
 * The database stores `is_active` and `role`; the API exposes the derived
 * `status` and `is_superuser` fields so the UI has one vocabulary.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { adminRequired, revokeUserSessions } = require('../lib/auth');
const { toUser, toPage } = require('../lib/dto');
const { parsePositiveInt } = require('../lib/util');
const { isAllTenants, resolveWriteTenant } = require('../lib/tenant');
const { auditAction } = require('../lib/audit');
const { asyncHandler } = require('../lib/http');

const ROLES = ['admin', 'editor', 'viewer'];
const MIN_PASSWORD_LENGTH = 6;

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createUsersRouter({ db }) {
  const router = express.Router();
  const requireAdmin = adminRequired(db);

  router.get('/users', requireAdmin, asyncHandler(async (req, res) => {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const pageSize = parsePositiveInt(req.query.page_size, 20, 200);
    const where = [];
    const params = [];

    const keyword = String(req.query.keyword || req.query.q || '').trim();
    if (keyword) {
      where.push('(username LIKE ? OR email LIKE ? OR display_name LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like);
    }
    if (req.query.role) {
      const role = String(req.query.role);
      if (!ROLES.includes(role)) {
        return res.status(400).json({ detail: `Unsupported role: ${role}` });
      }
      where.push('role = ?');
      params.push(role);
    }
    const status = String(req.query.status || '');
    if (status === 'active') {
      where.push('is_active = 1');
    } else if (status === 'disabled') {
      where.push('is_active = 0');
    } else if (status) {
      return res.status(400).json({ detail: `Unsupported status: ${status}` });
    }

    // The tenant is part of the filter, not a request parameter: a caller
    // sees the users of the tenant its credential speaks for. A platform
    // administrator's scope covers every tenant, so their filter names no
    // tenant at all.
    if (isAllTenants(req.tenantScope)) {
      // tenant-lint: allow a superadmin reads across every tenant
      where.unshift('tenant_id IS NOT NULL');
    } else {
      where.unshift('tenant_id = ?');
      params.unshift(req.tenantScope.tenantId);
    }

    // `where[0]` is always the tenant condition, pushed above, so the
    // fragment every query here composes carries it.
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = Number(
      (await db.prepare(`SELECT COUNT(*) AS c FROM users ${whereSql} -- tenant`).get(...params)).c,
    );
    const offset = (page - 1) * pageSize;
    const rows = await db
      .prepare(`SELECT * FROM users ${whereSql} ORDER BY created_at ASC LIMIT ? OFFSET ? -- tenant`)
      .all(...params, pageSize, offset);
    return res.json(toPage(rows.map(toUser), total, page, pageSize));
  }));

  router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
    const { username, email, password, display_name, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ detail: 'username/password required' });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        detail: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    const safeRole = ROLES.includes(role) ? role : 'viewer';
    const id = nanoid();
    // A write lands in one concrete tenant — see `resolveWriteTenant`. For
    // everybody else that is the tenant their credential speaks for; a
    // platform administrator names it in `X-Tenant`, which narrows their
    // scope to that tenant before this handler runs.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    try {
      await db
        .prepare(
          'INSERT INTO users (id, tenant_id, username, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          tenantId,
          String(username),
          email || null,
          display_name || null,
          bcrypt.hashSync(String(password), 10),
          safeRole,
        );
    } catch (e) {
      return res.status(400).json({ detail: e.message });
    }
    const row = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId);
    await auditAction(db, req, {
      action: 'user.created',
      resourceType: 'user',
      resourceId: id,
      details: { username: String(username), role: safeRole },
    });
    return res.status(201).json(toUser(row));
  }));

  router.put('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    const target = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!target) return res.status(404).json({ detail: 'Not found' });

    const { email, display_name, role, status } = req.body || {};
    if (role !== undefined && role !== null && !ROLES.includes(String(role))) {
      return res.status(400).json({ detail: `Unsupported role: ${role}` });
    }
    if (status !== undefined && status !== null && !['active', 'disabled'].includes(String(status))) {
      return res.status(400).json({ detail: `Unsupported status: ${status}` });
    }
    // Never let the last active admin be demoted or disabled — that would
    // lock everybody out of the admin API.
    const losesAdmin =
      target.role === 'admin' &&
      ((role !== undefined && role !== null && String(role) !== 'admin') ||
        (status !== undefined && status !== null && String(status) === 'disabled'));
    if (losesAdmin) {
      const adminCount = Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND role = 'admin' AND is_active = 1",
            )
            .get(tenantId)
        ).c,
      );
      if (adminCount <= 1) {
        return res.status(400).json({ detail: 'The last active admin cannot be demoted or disabled' });
      }
    }

    const nextRole = role === undefined || role === null ? target.role : String(role);
    const nextIsActive =
      status === undefined || status === null
        ? target.is_active
        : status === 'active'
          ? 1
          : 0;
    await db
      .prepare(
        'UPDATE users SET email = ?, display_name = ?, role = ?, is_active = ? WHERE id = ? AND tenant_id = ?',
      )
      .run(
        email !== undefined ? email : target.email,
        display_name !== undefined ? display_name : target.display_name,
        nextRole,
        nextIsActive,
        target.id,
        tenantId,
      );
    const row = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(target.id, tenantId);
    await auditAction(db, req, {
      action: 'user.updated',
      resourceType: 'user',
      resourceId: target.id,
      details: { username: target.username, role: nextRole, status: nextIsActive ? 'active' : 'disabled' },
    });
    return res.json(toUser(row));
  }));

  router.delete('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    const target = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!target) return res.status(404).json({ detail: 'Not found' });
    if (target.id === req.user.id) {
      return res.status(400).json({ detail: 'You cannot delete your own account' });
    }
    if (target.role === 'admin') {
      const adminCount = Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND role = 'admin' AND is_active = 1",
            )
            .get(tenantId)
        ).c,
      );
      if (adminCount <= 1) {
        return res.status(400).json({ detail: 'The last active admin cannot be deleted' });
      }
    }
    await db.prepare('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(target.id, tenantId);
    await auditAction(db, req, {
      action: 'user.deleted',
      resourceType: 'user',
      resourceId: target.id,
      details: { username: target.username, role: target.role },
    });
    return res.status(204).end();
  }));

  router.post('/users/:id/reset-password', requireAdmin, asyncHandler(async (req, res) => {
    // A write lands in one concrete tenant — see `resolveWriteTenant`. A
    // platform administrator who has not named one is refused with a 400 that
    // says so, instead of a 404 that reads like a missing row.
    const tenantId = await resolveWriteTenant(db, req.tenantScope);
    const target = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId);
    if (!target) return res.status(404).json({ detail: 'Not found' });
    // The new password comes from the body and from nowhere else: a query
    // string ends up in the server's request log, in the proxy's log and in
    // the browser's history, and a password that lands in any of those is a
    // password that is no longer secret.
    const newPassword = req.body && req.body.new_password;
    if (!newPassword) {
      return res.status(400).json({ detail: 'new_password required' });
    }
    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        detail: `new_password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    await db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
      .run(bcrypt.hashSync(String(newPassword), 10), target.id, tenantId);
    // The sessions opened with the old password end here: a token that
    // outlives the password it was issued against cannot be taken back by
    // changing that password. The tenant is the target's own — the
    // administrator who resets it may be a platform administrator whose
    // scope names every tenant and therefore none of them.
    await revokeUserSessions(db, target.id, target.tenant_id);
    await auditAction(db, req, {
      action: 'user.password_reset',
      resourceType: 'user',
      resourceId: target.id,
      details: { username: target.username },
    });
    return res.status(204).end();
  }));

  return router;
}

module.exports = createUsersRouter;
