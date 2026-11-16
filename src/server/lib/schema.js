'use strict';

/**
 * Database schema and idempotent migrations.
 *
 * This module owns the DDL: every `CREATE TABLE` and every `ALTER` the
 * server runs against a fresh or an existing database. The first-boot data
 * lives next door in `seed.js`; `server.js` only wires both into the app
 * lifecycle.
 *
 * Migrations are written as "add the column if it is missing" rather than
 * "ALTER unconditionally": MySQL 5.7 has no `ADD COLUMN IF NOT EXISTS`, and
 * running a plain ALTER on every boot crashes the second boot with
 * `ER_DUP_FIELDNAME`. We deliberately do NOT wrap these in try/catch — that
 * would silently swallow real errors such as a permissions problem.
 */

const { ensureColumns, existingIndexes } = require('./db');
const {
  DEFAULT_TENANT_ID,
  TENANT_ID_COLUMN,
  TENANT_SCOPED_TABLES,
  TENANT_UNIQUE_KEYS,
  tenantUniqueKeyName,
  migrateToMultiTenant,
} = require('./tenant-schema');

/**
 * The character set and collation every table uses.
 *
 * `DEFAULT CHARSET=` is the table-option form MySQL expects; a bare
 * `utf8mb4` there is a parse error.
 */
const CHARSET = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

/**
 * The primary key type.
 *
 * The ids are nanoid strings, so a fixed-width `VARCHAR` is both smaller
 * than `TEXT` and indexable — MySQL cannot index a `TEXT` column without a
 * prefix length.
 */
const ID = 'VARCHAR(64)';

/** A timestamp column. `DATETIME` with a `CURRENT_TIMESTAMP` default. */
const TIMESTAMP = 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';

/** Columns added to `assets` after the initial release. */
const ASSETS_COLUMN_DEFS = [
  'source_tool TEXT',
  'prompt TEXT',
  'seed BIGINT',
  'model_name VARCHAR(191)',
  'job_id VARCHAR(64)',
  'metadata_json TEXT',
  'deleted_at DATETIME',
];

/** Columns added to `users` after the initial release. */
const USERS_COLUMN_DEFS = ['display_name VARCHAR(191)', 'last_login_at DATETIME'];

/** Columns added to `webhook_endpoints` after the initial release. */
const WEBHOOK_ENDPOINTS_COLUMN_DEFS = ['events TEXT'];

/**
 * The `tenants` table — the first table, because every other table's rows
 * point at one of its rows.
 */
const TENANTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tenants (
  id ${ID} NOT NULL PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  settings_json TEXT,
  created_at ${TIMESTAMP},
  UNIQUE KEY uq_tenants_slug (slug)
) ENGINE=InnoDB ${CHARSET}`;

/**
 * The statements that create the schema, in dependency order.
 *
 * A fresh database is created *already tenant-scoped*: every business table
 * carries `tenant_id` and every unique key is composite over
 * `(tenant_id, …)`. The ALTER-based migration in `tenant-schema.js` is only
 * needed for a database that was created before the multi-tenant release —
 * building the tables twice would cost a table rebuild per table on every
 * fresh install.
 */
const BASE_SCHEMA_SQL = [
  TENANTS_TABLE_SQL,

  `CREATE TABLE IF NOT EXISTS users (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  username VARCHAR(191) NOT NULL,
  email VARCHAR(191),
  password_hash VARCHAR(191) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'viewer',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_name VARCHAR(191),
  last_login_at DATETIME,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('users', 'username')} (tenant_id, username)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS categories (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  parent_id ${ID},
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('categories', 'name')} (tenant_id, name),
  UNIQUE KEY ${tenantUniqueKeyName('categories', 'slug')} (tenant_id, slug)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS tags (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  color VARCHAR(32),
  usage_count INT NOT NULL DEFAULT 0,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('tags', 'name')} (tenant_id, name),
  UNIQUE KEY ${tenantUniqueKeyName('tags', 'slug')} (tenant_id, slug)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS assets (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  title VARCHAR(191) NOT NULL,
  description TEXT,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(191) NOT NULL,
  file_size BIGINT NOT NULL,
  file_hash VARCHAR(191) NOT NULL,
  asset_type VARCHAR(32) NOT NULL,
  category_id ${ID},
  width INT,
  height INT,
  duration DOUBLE,
  storage_path VARCHAR(255) NOT NULL,
  thumbnail_path VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'ready',
  uploaded_by ${ID},
  source VARCHAR(32) NOT NULL DEFAULT 'admin',
  source_tool TEXT,
  prompt TEXT,
  seed BIGINT,
  model_name VARCHAR(191),
  job_id VARCHAR(64),
  metadata_json TEXT,
  deleted_at DATETIME,
  created_at ${TIMESTAMP},
  updated_at ${TIMESTAMP} ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS asset_tags (
  ${TENANT_ID_COLUMN},
  asset_id ${ID} NOT NULL,
  tag_id ${ID} NOT NULL,
  PRIMARY KEY (tenant_id, asset_id, tag_id),
  KEY idx_asset_tags_tag (tag_id)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS api_keys (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  key_hash VARCHAR(191) NOT NULL,
  scopes VARCHAR(255) NOT NULL DEFAULT 'read,upload',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_used_at DATETIME,
  expires_at DATETIME,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('api_keys', 'key_hash')} (tenant_id, key_hash)
) ENGINE=InnoDB ${CHARSET}`,

  // The MCP tokens: one row per account per client. An MCP token speaks for
  // the account that issued it, so it carries that account's tenant — a
  // credential that could name its own tenant would be able to name somebody
  // else's.
  `CREATE TABLE IF NOT EXISTS mcp_tokens (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  user_id ${ID} NOT NULL,
  name VARCHAR(191) NOT NULL,
  token_prefix VARCHAR(32) NOT NULL,
  token_hash VARCHAR(191) NOT NULL,
  scopes VARCHAR(255) NOT NULL DEFAULT 'read',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_used_at DATETIME,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('mcp_tokens', 'token_hash')} (tenant_id, token_hash)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  user_id ${ID},
  action VARCHAR(191) NOT NULL,
  resource_type VARCHAR(191) NOT NULL,
  resource_id VARCHAR(191),
  details TEXT,
  ip_address VARCHAR(64),
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  // The request log: one row per API call, with what came in and what went
  // back out.
  //
  // This is the **traffic** record, not the audit trail: the audit trail says
  // what a person changed, this says what the instance was asked to do and how
  // much it moved. A row belongs to the tenant the request spoke for, so the
  // platform layer can read the whole platform's traffic and a tenant can read
  // its own.
  //
  // It grows by one row per request, so it is pruned on a retention window —
  // an unbounded log is a disk that fills on its own.
  `CREATE TABLE IF NOT EXISTS request_logs (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  user_id ${ID},
  method VARCHAR(8) NOT NULL,
  path VARCHAR(255) NOT NULL,
  route VARCHAR(191) NOT NULL DEFAULT '',
  status INT NOT NULL,
  duration_ms INT NOT NULL DEFAULT 0,
  bytes_in BIGINT NOT NULL DEFAULT 0,
  bytes_out BIGINT NOT NULL DEFAULT 0,
  ip_address VARCHAR(64),
  created_at ${TIMESTAMP},
  KEY idx_request_logs_created (created_at),
  KEY idx_request_logs_tenant (tenant_id, created_at)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  url VARCHAR(1024) NOT NULL,
  secret VARCHAR(191) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  events TEXT,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS webhook_logs (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  endpoint_id ${ID} NOT NULL,
  event VARCHAR(191) NOT NULL,
  payload TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS manifest_writes (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  asset_id ${ID},
  op VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  expires_at DATETIME,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS token_registry (
  jti ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  user_id ${ID},
  kind VARCHAR(32),
  expires_at DATETIME
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS upload_sessions (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  owner_id ${ID},
  filename VARCHAR(255) NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(191),
  file_hash VARCHAR(191),
  chunk_size BIGINT NOT NULL,
  total_chunks INT NOT NULL,
  received_chunks TEXT NOT NULL,
  title VARCHAR(191),
  description TEXT,
  category_id ${ID},
  tag_names TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  expires_at DATETIME,
  created_at ${TIMESTAMP},
  updated_at ${TIMESTAMP} ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB ${CHARSET}`,
];

/**
 * The indexes, created only when they are missing.
 *
 * `source_tool` is a TEXT column, and MySQL cannot index a TEXT column
 * without a prefix length — hence the `(191)`.
 */
const INDEX_DEFS = [
  ['idx_assets_hash', 'assets (file_hash)'],
  ['idx_assets_type', 'assets (asset_type)'],
  ['idx_assets_created', 'assets (created_at)'],
  ['idx_assets_job_id', 'assets (job_id)'],
  ['idx_assets_source_tool', 'assets (source_tool(191))'],
  ['idx_assets_status', 'assets (status)'],
  ['idx_asset_tags_tag', 'asset_tags (tag_id)'],
];

/**
 * Is this database empty — no `tenants` table yet?
 *
 * Checked *before* the DDL runs, so it distinguishes "this module created the
 * schema just now" from "the schema was already here". Only the former can
 * skip the ALTER passes.
 *
 * @param {object} db
 * @returns {Promise<boolean>}
 */
async function isSchemaAbsent(db) {
  const rows = await db.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants'`,
  );
  return Number(rows[0].c) === 0;
}

/**
 * Create the indexes that are missing.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function ensureIndexes(db) {
  // The index set of a table does not change while its indexes are being
  // created, so each table is read once instead of once per index —
  // `information_schema.STATISTICS` is the expensive read here.
  const indexesByTable = new Map();
  for (const [name, target] of INDEX_DEFS) {
    const table = target.split(' ')[0];
    if (!indexesByTable.has(table)) {
      indexesByTable.set(table, await existingIndexes(db, table));
    }
    if (indexesByTable.get(table).has(name)) continue;
    await db.exec(`CREATE INDEX ${name} ON ${target}`);
    indexesByTable.get(table).add(name);
  }
}

/**
 * Create the schema and bring an existing database up to date.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function initSchema(db) {
  const isFreshDatabase = await isSchemaAbsent(db);
  for (const sql of BASE_SCHEMA_SQL) {
    await db.exec(sql);
  }
  // On a database this module just created, the DDL already carries every
  // column the ALTER passes would add. Running them anyway costs a table
  // rebuild per column — measured at ~1 s each on the dev instance, which
  // is what made a fresh boot take 20 s. The passes are kept (and skipped
  // here) because a database created by an older release still needs them.
  if (!isFreshDatabase) {
    await ensureColumns(db, 'assets', ASSETS_COLUMN_DEFS);
    await ensureColumns(db, 'users', USERS_COLUMN_DEFS);
    await ensureColumns(db, 'webhook_endpoints', WEBHOOK_ENDPOINTS_COLUMN_DEFS);
  }
  await ensureIndexes(db);
  // The tenant layer comes last: the columns have to exist before the
  // composite unique keys and the composite primary key can reference them.
  // On a fresh database both are already part of the DDL, and the function
  // is a no-op.
  await migrateToMultiTenant(db);
}

module.exports = {
  initSchema,
  ASSETS_COLUMN_DEFS,
  USERS_COLUMN_DEFS,
  WEBHOOK_ENDPOINTS_COLUMN_DEFS,
  TENANTS_TABLE_SQL,
  TENANT_SCOPED_TABLES,
  TENANT_UNIQUE_KEYS,
  tenantUniqueKeyName,
  DEFAULT_TENANT_ID,
};
