'use strict';

/**
 * Fixture — the marker with nothing behind it.
 *
 * The SQL carries `-- tenant`, which tells a reviewer "a builder emits the
 * tenant condition", but this file has no builder at all: the condition
 * arrives as a parameter. That is precisely the case the marker must not be
 * able to cover on its own.
 */

async function list(db, whereSql, params) {
  return db.prepare(`SELECT * FROM assets a ${whereSql} -- tenant`).all(...params);
}

module.exports = { list };
