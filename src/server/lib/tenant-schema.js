'use strict';

/**
 * The tenant layer of the schema.
 *
 * Multi-tenancy is a column, not a separate database: every business row
 * carries a `tenant_id` that points at one row of the `tenants` table, and
 * the tenant identity travels with the credential (the JWT's `tid` claim or
 * the API key's `tenant_id`) — never with the request body.
 *
 * This module owns the three things the migration needs:
 *
 *   - the list of tables whose rows belong to a tenant,
 *   - the unique keys that have to become tenant-scoped,
 *   - the migration that turns a single-tenant database into a multi-tenant
 *     one — idempotently, so a restart never fails.
 *
 * The `tenants` table itself lives in `schema.js`, next to the other DDL.
 */

const { ensureColumns, existingIndexes, primaryKeyColumns } = require('./db');

/**
 * The tenant every row belongs to when an existing database is upgraded.
 *
 * A single-tenant installation has no way to know which tenant its rows
 * belong to, so the migration puts them all in this one.
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Every table whose rows belong to one tenant.
 *
 * The tenant identity travels with the credential (the JWT's `tid` claim or
 * the API key's `tenant_id`), never with the request body — so every table
 * that holds tenant-owned data needs the column.
 */
const TENANT_SCOPED_TABLES = [
  'users',
  'assets',
  'asset_tags',
  'categories',
  'tags',
  'api_keys',
  'audit_logs',
  'webhook_endpoints',
  'webhook_logs',
  'manifest_writes',
  'upload_sessions',
  'token_registry',
  'revoked_tokens',
];

/**
 * The unique keys that must become tenant-scoped.
 *
 * Each entry is `[table, oldIndexName, column]`: the old index is global and
 * is replaced by a composite one over `(tenant_id, column)`. Without that,
 * two tenants could not both own a category called "产品图".
 *
 * The old index name is `null` when the table had no such constraint — an
 * API key's hash was never unique, and the spec wants it to become unique
 * *per tenant* rather than globally.
 */
const TENANT_UNIQUE_KEYS = [
  ['users', 'uq_users_username', 'username'],
  ['categories', 'uq_categories_name', 'name'],
  ['categories', 'uq_categories_slug', 'slug'],
  ['tags', 'uq_tags_name', 'name'],
  ['tags', 'uq_tags_slug', 'slug'],
  ['api_keys', null, 'key_hash'],
];

/**
 * The `tenant_id` column every tenant-scoped table carries.
 *
 * The default is the migration's tenant: an existing row keeps its data and
 * joins the tenant the installation started in.
 */
const TENANT_ID_COLUMN = `tenant_id VARCHAR(64) NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`;

/**
 * The name of the tenant-scoped replacement for a unique key.
 *
 * @param {string} table
 * @param {string} column
 * @returns {string}
 */
function tenantUniqueKeyName(table, column) {
  return `uq_${table}_tenant_${column}`;
}

/**
 * Give every tenant-scoped table its `tenant_id` column.
 *
 * The column is added with the default tenant as its default value, so the
 * rows of an existing database keep their data and simply join the tenant
 * the installation started in.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function ensureTenantColumns(db) {
  for (const table of TENANT_SCOPED_TABLES) {
    await ensureColumns(db, table, [TENANT_ID_COLUMN]);
  }
}

/**
 * Replace the global unique keys by tenant-scoped ones.
 *
 * A username, a category name or a tag name is unique *per tenant*, not
 * globally: two tenants must be able to both own a category called "产品图".
 * The old index is dropped and the composite one takes its place. The old
 * index may already be gone (a fresh database is created with the composite
 * key), so its presence is checked first.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function ensureTenantUniqueKeys(db) {
  for (const [table, oldIndex, column] of TENANT_UNIQUE_KEYS) {
    const existing = await existingIndexes(db, table);
    if (oldIndex && existing.has(oldIndex)) {
      await db.exec(`ALTER TABLE ${table} DROP INDEX ${oldIndex}`);
    }
    const newIndex = tenantUniqueKeyName(table, column);
    if (!existing.has(newIndex)) {
      await db.exec(`CREATE UNIQUE INDEX ${newIndex} ON ${table} (tenant_id, ${column})`);
    }
  }
}

/**
 * Re-key `asset_tags` by tenant.
 *
 * The same tag may be attached to the same asset in two different tenants,
 * so the primary key becomes `(tenant_id, asset_id, tag_id)`.
 *
 * MySQL 5.7 cannot change a primary key in place, so the steps are ordered:
 * add the column, drop the old primary key, add the new one and backfill.
 * Adding the column with a default already fills the existing rows; the
 * explicit backfill covers a database where `tenant_id` was added by hand
 * as a nullable column.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function ensureAssetTagsPrimaryKey(db) {
  const current = await primaryKeyColumns(db, 'asset_tags');
  const isAlreadyTenantScoped =
    current.length === 3 &&
    current[0] === 'tenant_id' &&
    current[1] === 'asset_id' &&
    current[2] === 'tag_id';
  if (isAlreadyTenantScoped) return;

  await db.exec('ALTER TABLE asset_tags DROP PRIMARY KEY');
  await db.exec('ALTER TABLE asset_tags ADD PRIMARY KEY (tenant_id, asset_id, tag_id)');
  await db.exec(`UPDATE asset_tags SET tenant_id = '${DEFAULT_TENANT_ID}' WHERE tenant_id IS NULL`);
}

/**
 * Turn a single-tenant database into a multi-tenant one.
 *
 * The order matters: the column has to exist before the composite unique
 * keys and the composite primary key can reference it.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function migrateToMultiTenant(db) {
  await ensureTenantColumns(db);
  await ensureAssetTagsPrimaryKey(db);
  await ensureTenantUniqueKeys(db);
}

module.exports = {
  DEFAULT_TENANT_ID,
  TENANT_SCOPED_TABLES,
  TENANT_UNIQUE_KEYS,
  TENANT_ID_COLUMN,
  tenantUniqueKeyName,
  migrateToMultiTenant,
};
