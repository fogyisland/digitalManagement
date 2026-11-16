'use strict';

/**
 * The ComfyUI nodes that talk to this instance.
 *
 * A node announces itself with `POST /api/ingest/v1/nodes/register` and keeps
 * announcing itself: the row is keyed by the node's own key, so the same
 * ComfyUI installation is one row that gets newer, not a growing list of
 * copies.
 *
 * The tenant is the one the announcing API key belongs to — the node never
 * names it, and it cannot: the key is the credential, and the credential
 * already knows whose data it may write.
 *
 * There is no `status` column. Whether a node is online is a question about
 * how long ago it last spoke, and that answer changes with the clock rather
 * than with the row — so it is computed when the node is read.
 */

const { nanoid } = require('nanoid');
const { parseDateTime } = require('./auth');
const { toMysqlDateTime } = require('./util');
const { ALL_TENANTS } = require('./tenant');

/**
 * How long a node may stay silent and still count as online.
 *
 * A node that says nothing for a quarter of an hour is not doing work. The
 * number is a judgement, not a fact, and it is written down here so that the
 * interface and the API cannot disagree about it.
 */
const NODE_STALE_MINUTES = 15;

/** The same judgement, in the unit the clock counts in. */
const NODE_STALE_MS = NODE_STALE_MINUTES * 60 * 1000;

/**
 * The columns a node row is read with.
 *
 * The status is not among them: it changes with the clock rather than with the
 * row, and a stored copy would go stale by itself.
 */
const NODE_COLUMNS = `id, node_key, name, version, comfyui_version, platform,
       last_seen_at, created_at, updated_at`;

/**
 * Whether a node is online.
 *
 * The question is "how long ago did it last speak", and answering it needs
 * two clocks to agree: the one that wrote the timestamp and the one that
 * reads it. The column holds a naive string — `YYYY-MM-DD HH:MM:SS` — and V8
 * reads that form as LOCAL time, which on a machine that is not on UTC shifts
 * the answer by the machine's offset. Enough to call every node offline, and
 * enough to call a live node idle for eight hours.
 *
 * So the string is read the one way this codebase reads a DATETIME:
 * `parseDateTime`, which takes the naive form for the UTC instant it is.
 *
 * The other half of the question is the clock the answer is compared against.
 * `last_seen_at` is stamped by this process, not by the database, so both
 * sides of the subtraction come from the same clock and cannot drift apart.
 *
 * @param {string|Date|null|undefined} lastSeenAt
 * @returns {'online'|'offline'}
 */
function nodeStatus(lastSeenAt) {
  const when = parseDateTime(lastSeenAt);
  if (!when) return 'offline';
  const age = Date.now() - when.getTime();
  // A timestamp in the future means the two clocks disagree — the node spoke
  // after the moment we are comparing against, not that it went quiet.
  if (age < 0) return 'online';
  return age <= NODE_STALE_MS ? 'online' : 'offline';
}

/**
 * Serialize a `comfy_nodes` row into the shape the interface and the node
 * both read.
 *
 * @param {any} row
 * @returns {object}
 */
function toComfyNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    node_key: row.node_key,
    name: row.name,
    version: row.version ?? null,
    comfyui_version: row.comfyui_version ?? null,
    platform: row.platform ?? null,
    status: nodeStatus(row.last_seen_at),
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Register a node, or refresh the row of a node that is already registered.
 *
 * The registration is idempotent: the same `node_key` in the same tenant
 * always lands on the same row, so a node that re-announces itself every time
 * it runs leaves one row behind, not one per run.
 *
 * @param {object} db
 * @param {{tenantId: string, nodeKey: string, name?: string, version?: string,
 *          comfyuiVersion?: string, platform?: string}} input
 * @returns {Promise<object>} the row, as `toComfyNode` renders it
 */
async function registerNode(db, input) {
  const tenantId = String(input.tenantId || '').trim();
  if (!tenantId) {
    throw Object.assign(new Error('A node registration needs a tenant'), {
      status: 400,
      code: 'TENANT_REQUIRED',
    });
  }
  const nodeKey = String(input.nodeKey || '').trim();
  if (!nodeKey) {
    throw Object.assign(new Error('node_key required'), {
      status: 400,
      code: 'NODE_KEY_REQUIRED',
    });
  }
  // The name is what an operator reads in the interface, so a nameless node
  // falls back to its key rather than to an empty cell.
  const name = String(input.name || '').trim() || nodeKey;
  const version = String(input.version || '').trim() || null;
  const comfyuiVersion = String(input.comfyuiVersion || '').trim() || null;
  const platform = String(input.platform || '').trim() || null;
  // The heartbeat is stamped here rather than by the database, so that the
  // moment it records and the moment it is read against are the same clock.
  const seenAt = toMysqlDateTime(new Date());

  const existing = await db
    .prepare('SELECT id FROM comfy_nodes WHERE tenant_id = ? AND node_key = ?')
    .get(tenantId, nodeKey);

  if (existing) {
    await db
      .prepare(
        `UPDATE comfy_nodes SET name = ?, version = ?, comfyui_version = ?, platform = ?,
                last_seen_at = ?
           WHERE id = ? AND tenant_id = ?`,
      )
      .run(name, version, comfyuiVersion, platform, seenAt, existing.id, tenantId);
    const row = await db
      .prepare(`SELECT ${NODE_COLUMNS} FROM comfy_nodes WHERE id = ? AND tenant_id = ?`)
      .get(existing.id, tenantId);
    return toComfyNode(row);
  }

  const id = nanoid();
  await db
    .prepare(
      `INSERT INTO comfy_nodes (id, tenant_id, node_key, name, version, comfyui_version, platform, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tenantId, nodeKey, name, version, comfyuiVersion, platform, seenAt);

  const row = await db
    .prepare(`SELECT ${NODE_COLUMNS} FROM comfy_nodes WHERE id = ? AND tenant_id = ?`)
    .get(id, tenantId);
  return toComfyNode(row);
}

/**
 * The nodes of one tenant, newest announcement first.
 *
 * @param {object} db
 * @param {{tenantId: string}} scope
 * @returns {Promise<object[]>}
 */
async function listNodes(db, scope) {
  const tenantId = scope && scope.tenantId;
  if (!tenantId) {
    throw Object.assign(new Error('A node listing needs a tenant scope'), {
      status: 403,
      code: 'NO_TENANT_SCOPE',
    });
  }
  if (tenantId === ALL_TENANTS) {
    // A platform administrator's scope covers every tenant, so this branch
    // deliberately has no tenant condition.
    // tenant-lint: allow a superadmin reads across every tenant
    const rows = await db
      .prepare(`SELECT ${NODE_COLUMNS} FROM comfy_nodes ORDER BY last_seen_at DESC, created_at DESC`)
      .all();
    return rows.map(toComfyNode);
  }
  const rows = await db
    .prepare(
      `SELECT ${NODE_COLUMNS} FROM comfy_nodes WHERE tenant_id = ?
        ORDER BY last_seen_at DESC, created_at DESC`,
    )
    .all(tenantId);
  return rows.map(toComfyNode);
}

/**
 * Read one node by its own key.
 *
 * @param {object} db
 * @param {string} tenantId
 * @param {string} nodeKey
 * @returns {Promise<object|null>}
 */
async function findNodeByKey(db, tenantId, nodeKey) {
  const row = await db
    .prepare(`SELECT ${NODE_COLUMNS} FROM comfy_nodes WHERE tenant_id = ? AND node_key = ?`)
    .get(String(tenantId), String(nodeKey));
  return row ? toComfyNode(row) : null;
}

module.exports = {
  NODE_STALE_MINUTES,
  nodeStatus,
  toComfyNode,
  registerNode,
  listNodes,
  findNodeByKey,
};
