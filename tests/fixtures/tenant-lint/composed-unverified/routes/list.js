'use strict';

/**
 * Fixture — the blind spot the tenant lint cannot see.
 *
 * The tenant predicate *is* pushed, and the SQL carries the `-- tenant`
 * marker, so the SQL-text lint passes. But the predicate is pushed last, and
 * the fragment before it is unparenthesised, so the composed condition reads
 * `tenant_id = ? AND title LIKE ?` — a later fragment can widen the result.
 */

async function list(db, scope, query) {
  const where = [];
  const params = [];

  if (query.q) {
    where.push('a.title LIKE ?');
    params.push(`%${query.q}%`);
  }

  where.push('a.tenant_id = ?');
  params.push(scope.tenantId);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  return db.prepare(`SELECT * FROM assets a ${whereSql} -- tenant`).all(...params);
}

module.exports = { list };
