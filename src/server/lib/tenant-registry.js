'use strict';

/**
 * The tenant registry — what a platform administrator does to a tenant.
 *
 * A tenant is the boundary every row of the library belongs to. The setup
 * wizard creates the first one and the seed creates the default one; this
 * module owns everything that happens to a tenant afterwards — creating one,
 * renaming it, suspending it, and removing it together with everything inside
 * it.
 *
 * It lives in the library rather than in the route so that the HTTP API and
 * the operator command (`npm run tenant:create`) enforce the same rules. Two
 * implementations of "what a valid tenant is" would drift, and the drift would
 * show up as a tenant the console made and the API refuses — or worse, the
 * other way round.
 *
 * ## The id is ASCII, on purpose
 *
 * A request names its tenant in the `X-Tenant` header, and a header value has
 * to be a byte string: a tenant whose name is Chinese cannot be named that way
 * at all. The id is therefore always ASCII — the slug when the slug is ASCII,
 * a generated one when it is not — so that every tenant can be addressed.
 */

const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const { slugify } = require('./util');

/** The longest id and slug the `tenants` table accepts. */
const MAX_KEY_LENGTH = 64;

/** The longest name the `tenants` table accepts. */
const MAX_NAME_LENGTH = 191;

/** The statuses a tenant may be in. */
const TENANT_STATUSES = ['active', 'suspended'];

/**
 * Every table whose rows belong to a tenant.
 *
 * The list is written out rather than read from `information_schema`: a
 * reviewer has to be able to see what a tenant's removal takes with it, and a
 * table that appears in the schema tomorrow is not removed until somebody says
 * so.
 *
 * `asset_tags` comes before `assets` and `webhook_logs` before
 * `webhook_endpoints` so the order reads like the dependency it describes,
 * even though the schema has no foreign keys to enforce it.
 */
const TENANT_OWNED_TABLES = [
  'asset_tags',
  'assets',
  'api_keys',
  'audit_logs',
  'categories',
  'manifest_writes',
  'mcp_tokens',
  'revoked_tokens',
  'tags',
  'token_registry',
  'upload_sessions',
  'users',
  'webhook_endpoints',
  'webhook_logs',
];

/**
 * An error the API answers with a status and a code.
 *
 * The code is what a caller branches on: `TENANT_EXISTS` and `NO_SUCH_TENANT`
 * mean different things to the client, and a sentence cannot be parsed.
 *
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function tenantError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Is this text usable as an id in an HTTP header?
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAsciiKey(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(value || ''));
}

/**
 * Validate the fields a tenant is created or updated with.
 *
 * A partial update only looks at the fields it was given; a create fills in
 * the rest. An id is never part of an update — it is the row's identity, and
 * changing it would move every row that points at it.
 *
 * @param {Record<string, any>} input the request body
 * @param {{partial?: boolean}} options
 * @returns {{name?: string, slug?: string, id?: string, status?: string}}
 * @throws {Error} 400 when a field is not usable
 */
function normalizeTenantInput(input, options = {}) {
  const partial = options.partial === true;
  const body = input || {};
  const out = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name === undefined ? '' : body.name).trim();
    if (!name) throw tenantError(400, 'TENANT_NAME_REQUIRED', 'A tenant needs a name');
    if (name.length > MAX_NAME_LENGTH) {
      throw tenantError(
        400,
        'TENANT_NAME_TOO_LONG',
        `The tenant name is too long (${MAX_NAME_LENGTH} characters at most)`,
      );
    }
    out.name = name;
  }

  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase();
    if (!slug || slug.length > MAX_KEY_LENGTH) {
      throw tenantError(
        400,
        'TENANT_SLUG_INVALID',
        `The slug must be between 1 and ${MAX_KEY_LENGTH} characters`,
      );
    }
    if (!isAsciiKey(slug)) {
      throw tenantError(
        400,
        'TENANT_SLUG_INVALID',
        'The slug may only hold letters, digits, dots, dashes and underscores',
      );
    }
    out.slug = slug;
  } else if (!partial) {
    // A Chinese name produces a Chinese slug, which is a fine slug but not a
    // usable id — so the slug is kept and the id falls back to a generated
    // one below.
    out.slug = slugify(String(out.name || '')).trim().toLowerCase();
    if (!out.slug) {
      throw tenantError(
        400,
        'TENANT_SLUG_INVALID',
        'The tenant name does not produce a usable slug — give the tenant a slug',
      );
    }
  }

  if (body.id !== undefined) {
    const id = String(body.id).trim();
    if (!id || id.length > MAX_KEY_LENGTH) {
      throw tenantError(
        400,
        'TENANT_ID_INVALID',
        `The id must be between 1 and ${MAX_KEY_LENGTH} characters`,
      );
    }
    if (!isAsciiKey(id)) {
      throw tenantError(
        400,
        'TENANT_ID_INVALID',
        'The id may only hold letters, digits, dots, dashes and underscores — ' +
          'a request names its tenant in a header, and a header holds bytes',
      );
    }
    out.id = id;
  } else if (!partial) {
    // The id follows the slug when the slug can be typed into a header, and is
    // generated when it cannot.
    out.id = isAsciiKey(out.slug) ? out.slug : nanoid();
  }

  if (body.status !== undefined) {
    const status = String(body.status).trim().toLowerCase();
    if (!TENANT_STATUSES.includes(status)) {
      throw tenantError(400, 'TENANT_STATUS_INVALID', `Unsupported status: ${status}`);
    }
    out.status = status;
  } else if (!partial) {
    out.status = 'active';
  }

  return out;
}

/**
 * Read one tenant.
 *
 * @param {object} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findTenant(db, id) {
  if (!id) return null;
  const row = await db
    .prepare('SELECT id, name, slug, status, created_at FROM tenants WHERE id = ?')
    .get(String(id));
  return row || null;
}

/**
 * Create a tenant.
 *
 * @param {object} db
 * @param {Record<string, any>} input `{name, slug?, id?, status?}`
 * @returns {Promise<object>} the created row
 * @throws {Error} 400 when a field is not usable, 409 when the id or slug is taken
 */
async function createTenant(db, input) {
  const fields = normalizeTenantInput(input);

  const taken = await db
    .prepare('SELECT id, slug, name FROM tenants WHERE id = ? OR slug = ?')
    .get([fields.id, fields.slug]);
  if (taken) {
    throw tenantError(
      409,
      'TENANT_EXISTS',
      `A tenant with the id "${taken.id}" (slug "${taken.slug}") already exists`,
    );
  }

  await db
    .prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
    .run([fields.id, fields.name, fields.slug, fields.status]);

  return {
    id: fields.id,
    name: fields.name,
    slug: fields.slug,
    status: fields.status,
    created_at: null,
  };
}

/**
 * Change a tenant.
 *
 * The name, the slug and the status may change; the id may not. A suspended
 * tenant keeps its rows — it is a switch, not a deletion.
 *
 * @param {object} db
 * @param {string} id
 * @param {Record<string, any>} input
 * @returns {Promise<object>} the updated row
 * @throws {Error} 400 when a field is not usable, 404 when there is no such
 *   tenant, 409 when the slug is taken by another tenant
 */
async function updateTenant(db, id, input) {
  const current = await findTenant(db, id);
  if (!current) {
    throw tenantError(404, 'NO_SUCH_TENANT', `There is no tenant '${id}'`);
  }

  const fields = normalizeTenantInput(input, { partial: true });
  const next = {
    name: fields.name === undefined ? current.name : fields.name,
    slug: fields.slug === undefined ? current.slug : fields.slug,
    status: fields.status === undefined ? current.status : fields.status,
  };

  if (next.slug !== current.slug) {
    const clash = await db
      .prepare('SELECT id FROM tenants WHERE slug = ? AND id <> ?')
      .get([next.slug, current.id]);
    if (clash) {
      throw tenantError(409, 'TENANT_EXISTS', `The slug "${next.slug}" is taken`);
    }
  }

  await db
    .prepare('UPDATE tenants SET name = ?, slug = ?, status = ? WHERE id = ?')
    .run([next.name, next.slug, next.status, current.id]);

  return { ...current, ...next };
}

/**
 * Remove a tenant and everything that belongs to it.
 *
 * This is the destructive one: the tenant's assets, users, categories, tags,
 * keys, webhooks and upload sessions go with it, and the files on disk are
 * unlinked. A suspended tenant is the reversible answer; this is the one that
 * leaves nothing behind.
 *
 * The rows go in one transaction — a half-removed tenant, with its users gone
 * and its assets still there, is worse than no removal at all.
 *
 * @param {object} db
 * @param {string} id
 * @param {{storageDir?: string}} options the storage root, so the files go too
 * @returns {Promise<{tenant: object, removed: Record<string, number>}>}
 * @throws {Error} 404 when there is no such tenant
 */
async function deleteTenant(db, id, options = {}) {
  const current = await findTenant(db, id);
  if (!current) {
    throw tenantError(404, 'NO_SUCH_TENANT', `There is no tenant '${id}'`);
  }

  // The files are read before the rows go: after the delete there is nothing
  // left that knows where they are.
  const files = await db
    .prepare('SELECT storage_path, thumbnail_path FROM assets WHERE tenant_id = ?')
    .all(String(current.id));

  const removed = await db.transaction(async (scoped) => {
    const counts = {};
    for (const table of TENANT_OWNED_TABLES) {
      const result = await scoped
        .prepare(`DELETE FROM ${table} WHERE tenant_id = ?`)
        .run(String(current.id));
      counts[table] = result.changes;
    }
    await scoped.prepare('DELETE FROM tenants WHERE id = ?').run([String(current.id)]);
    return counts;
  });

  removeStoredFiles(files, options.storageDir);

  return { tenant: current, removed };
}

/**
 * Unlink the files an asset list points at.
 *
 * Best effort on purpose: the rows are already gone, and a file that cannot
 * be unlinked (a lock, a permission) must not turn a completed deletion into
 * a failed request.
 *
 * @param {Array<{storage_path?: string, thumbnail_path?: string}>} files
 * @param {string} [storageDir]
 */
function removeStoredFiles(files, storageDir) {
  if (!storageDir) return;
  for (const file of files || []) {
    for (const relative of [file.storage_path, file.thumbnail_path]) {
      if (!relative) continue;
      const target = path.resolve(storageDir, String(relative));
      // A path that points outside the storage root is not this tenant's file.
      if (!target.startsWith(path.resolve(storageDir))) continue;
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          console.warn('[tenant] could not remove', target, error.message);
        }
      }
    }
  }
}

/**
 * How much a tenant holds.
 *
 * The numbers are what the platform administrator looks at before they
 * suspend or remove a tenant, so they are counted with the same tenant
 * condition every other query uses.
 *
 * The keys are the DTO's own (`asset_count`, `user_count`, …), so a caller can
 * spread them into a tenant row and the serializer picks them up. Naming them
 * differently here is how a count ends up silently zero in the interface.
 *
 * @param {object} db
 * @param {string} tenantId
 * @returns {Promise<{asset_count: number, user_count: number, category_count: number, tag_count: number}>}
 */
async function tenantCounts(db, tenantId) {
  const id = String(tenantId);
  const assets = await db.prepare('SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ?').get(id);
  const users = await db.prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?').get(id);
  const categories = await db
    .prepare('SELECT COUNT(*) AS c FROM categories WHERE tenant_id = ?')
    .get(id);
  const tags = await db.prepare('SELECT COUNT(*) AS c FROM tags WHERE tenant_id = ?').get(id);
  return {
    asset_count: Number(assets.c),
    user_count: Number(users.c),
    category_count: Number(categories.c),
    tag_count: Number(tags.c),
  };
}

module.exports = {
  MAX_KEY_LENGTH,
  TENANT_STATUSES,
  TENANT_OWNED_TABLES,
  normalizeTenantInput,
  findTenant,
  createTenant,
  updateTenant,
  deleteTenant,
  tenantCounts,
};
