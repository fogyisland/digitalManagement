'use strict';

/**
 * Fixture — tenant first, but a later fragment can still widen it.
 *
 * `tenant_id = ? AND title LIKE ? OR uploaded_by = ?` binds as
 * `(tenant_id = ? AND title LIKE ?) OR uploaded_by = ?`, so the OR escapes
 * the tenant slice. A fragment carrying OR has to bring its own parentheses.
 */

async function list(db, scope, query) {
  const where = [];
  const params = [];

  where.push('a.tenant_id = ?');
  params.push(scope.tenantId);

  where.push('a.title LIKE ? OR a.uploaded_by = ?');
  params.push(`%${query.q}%`, query.uploaderId);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  return db.prepare(`SELECT * FROM assets a ${whereSql} -- tenant`).all(...params);
}

module.exports = { list };
