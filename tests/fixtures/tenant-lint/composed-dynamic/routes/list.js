'use strict';

/**
 * Fixture — a fragment this lint cannot read.
 *
 * The tenant fragment is anchored first, but one condition arrives as a
 * variable, so whatever that variable holds is unaudited. A builder is only
 * as trustworthy as its least readable fragment.
 */

async function list(db, scope, extraCondition) {
  const where = [];
  const params = [];

  where.push('a.tenant_id = ?');
  params.push(scope.tenantId);

  where.push(extraCondition);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  return db.prepare(`SELECT * FROM assets a ${whereSql} -- tenant`).all(...params);
}

module.exports = { list };
