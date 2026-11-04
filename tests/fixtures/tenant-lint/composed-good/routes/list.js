'use strict';

/**
 * Fixture — what the composed-condition rule accepts.
 *
 * The builder puts the tenant predicate first and gives every OR fragment its
 * own parentheses, so joining the fragments with `AND` can only narrow the
 * tenant's slice, never widen it. Nothing here is executed: the file is read
 * as text by `findUnverifiedComposedQueries`.
 */

async function list(db, scope, query) {
  const where = [];
  const params = [];

  where.push('a.tenant_id = ?');
  params.push(scope.tenantId);

  if (query.q) {
    where.push('(a.title LIKE ? OR a.description LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  return db.prepare(`SELECT * FROM assets a ${whereSql} -- tenant`).all(...params);
}

module.exports = { list };
