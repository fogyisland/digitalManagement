'use strict';

/**
 * MySQL access layer.
 *
 * The application was written against better-sqlite3, whose calls are
 * synchronous. MySQL is a network protocol, so every statement is a round
 * trip and every call has to be awaited. Rather than scatter `await` shapes
 * across the whole codebase, this module keeps the *shape* of the old calls
 * and changes only what they return:
 *
 *   const row  = await db.prepare('SELECT ...').get(params);
 *   const rows = await db.prepare('SELECT ...').all(params);
 *   const { changes } = await db.prepare('INSERT ...').run(params);
 *
 * `exec` runs raw SQL — several statements separated by `;` are allowed and
 * are executed one after another. It is used for DDL only.
 */

const mysql = require('mysql2/promise');

/** How many connections the pool keeps open. */
const DEFAULT_POOL_SIZE = 10;

/**
 * Open a connection that is not bound to a schema.
 *
 * The database itself has to exist before the pool can point at it, so the
 * server creates it with this connection first.
 *
 * @param {{dbHost: string, dbPort: number, dbUser: string, dbPassword: string}} config
 * @returns {Promise<import('mysql2/promise').PoolConnection>}
 */
async function createAdminConnection(config) {
  return mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
    multipleStatements: false,
  });
}

/**
 * Create the schema if it is not there yet.
 *
 * @param {{dbHost: string, dbPort: number, dbUser: string, dbPassword: string, dbName: string}} config
 * @returns {Promise<void>}
 */
async function ensureDatabase(config) {
  const connection = await createAdminConnection(config);
  try {
    // The name comes from the configuration, so it is quoted rather than
    // interpolated raw. Backticks are the MySQL identifier quote.
    const name = String(config.dbName).replace(/`/g, '``');
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await connection.end();
  }
}

/**
 * Open the connection pool.
 *
 * The pool is lazy — mysql2 connects on the first query — so this is
 * synchronous and the database handle can be handed to the routes before
 * the schema exists.
 *
 * `dateStrings` keeps DATE/DATETIME columns as `YYYY-MM-DD HH:MM:SS`
 * strings. Without it mysql2 hands back JavaScript `Date` objects, which
 * would change the JSON the API returns — the frontend and the DTO contract
 * both expect the string form.
 *
 * @param {{dbHost: string, dbPort: number, dbUser: string, dbPassword: string, dbName: string}} config
 * @returns {import('mysql2/promise').Pool}
 */
function createPool(config) {
  const pool = mysql.createPool({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    waitForConnections: true,
    connectionLimit: DEFAULT_POOL_SIZE,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
    dateStrings: true,
    // BIGINT columns must come back as numbers: `file_size` is part of the
    // DTO contract, and a string there would break the frontend. The values
    // involved (file sizes, row counts) are far below 2^53.
    supportBigNumbers: true,
    bigNumberStrings: false,
    // DECIMAL (SUM(file_size) and friends) has the same problem.
    decimalNumbers: true,
  });

  // Every connection gets the same session settings:
  //
  //   time_zone = '+00:00'      the code writes UTC timestamps, so the
  //                             database must agree — otherwise NOW() and
  //                             CURRENT_TIMESTAMP would be local time and
  //                             every comparison would be off by the
  //                             machine's UTC offset.
  //   group_concat_max_len      the default of 1024 bytes truncates the tag
  //                             list of an asset that has many tags.
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
    connection.query('SET SESSION group_concat_max_len = 1048576');
  });

  return pool;
}

/**
 * Normalize the parameters of a call.
 *
 * Two shapes are accepted: the variadic form the codebase has always used
 * (`run(a, b)`) and a single array (`run([a, b])`). `undefined` becomes
 * `null`, because MySQL refuses to bind an undefined value while SQLite
 * silently turned it into NULL.
 *
 * @param {unknown[]} params
 * @returns {unknown[]}
 */
function normalizeParams(params) {
  const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return list.map((value) => (value === undefined ? null : value));
}

/**
 * Wrap a pool in the query surface the application uses.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {object} the database handle passed around the codebase
 */
function createDb(pool) {
  return {
    /**
     * Prepare a statement.
     *
     * The returned object is not a real prepared statement — MySQL's
     * protocol does not expose one to the client — it is a small facade
     * that runs the SQL with the given parameters.
     *
     * @param {string} sql
     */
    prepare(sql) {
      return {
        /**
         * Run a statement that changes rows.
         *
         * @param {...unknown} params
         * @returns {Promise<{changes: number, lastInsertRowid: number}>}
         */
        async run(...params) {
          const [result] = await pool.execute(sql, normalizeParams(params));
          return { changes: result.affectedRows, lastInsertRowid: result.insertId };
        },

        /**
         * Run a statement and take the first row.
         *
         * @param {...unknown} params
         * @returns {Promise<object | undefined>}
         */
        async get(...params) {
          const [rows] = await pool.execute(sql, normalizeParams(params));
          return rows.length > 0 ? rows[0] : undefined;
        },

        /**
         * Run a statement and take every row.
         *
         * @param {...unknown} params
         * @returns {Promise<object[]>}
         */
        async all(...params) {
          const [rows] = await pool.execute(sql, normalizeParams(params));
          return rows;
        },
      };
    },

    /**
     * Run raw SQL — DDL and the like.
     *
     * @param {string} sql
     * @returns {Promise<void>}
     */
    async exec(sql) {
      await pool.query(sql);
    },

    /**
     * Run a function inside a transaction.
     *
     * The function receives the same handle the application uses, so the
     * statements inside it read exactly like the ones outside.
     *
     * @template T
     * @param {(db: object) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async transaction(fn) {
      const connection = await pool.getConnection();
      const scoped = {
        prepare(sql) {
          return {
            async run(...params) {
              const [result] = await connection.execute(sql, normalizeParams(params));
              return { changes: result.affectedRows, lastInsertRowid: result.insertId };
            },
            async get(...params) {
              const [rows] = await connection.execute(sql, normalizeParams(params));
              return rows.length > 0 ? rows[0] : undefined;
            },
            async all(...params) {
              const [rows] = await connection.execute(sql, normalizeParams(params));
              return rows;
            },
          };
        },
        async exec(sql) {
          await connection.query(sql);
        },
      };
      try {
        await connection.beginTransaction();
        const result = await fn(scoped);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    /** The underlying pool, for the few places that need it. */
    pool,
  };
}

/**
 * Create the database handle the application uses.
 *
 * @param {object} config the values from `getConfig()`
 * @returns {Promise<object>}
 */
async function connect(config) {
  await ensureDatabase(config);
  return createDb(createPool(config));
}

/**
 * The columns a table already has.
 *
 * @param {object} db
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function existingColumns(db, table) {
  const rows = await db
    .prepare(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    )
    .all([table]);
  return new Set(rows.map((row) => row.name));
}

/**
 * The indexes a table already has.
 *
 * @param {object} db
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function existingIndexes(db, table) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    )
    .all([table]);
  return new Set(rows.map((row) => row.name));
}

/**
 * The columns of a table's primary key, in key order.
 *
 * @param {object} db
 * @param {string} table
 * @returns {Promise<string[]>}
 */
async function primaryKeyColumns(db, table) {
  const rows = await db
    .prepare(
      `SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
    )
    .all([table]);
  return rows.map((row) => row.name);
}

/**
 * Add the missing columns of a table.
 *
 * @param {object} db
 * @param {string} table one of the hard-coded table names above
 * @param {string[]} columnDefs e.g. ["source_tool TEXT"]
 * @returns {Promise<void>}
 */
async function ensureColumns(db, table, columnDefs) {
  const existing = await existingColumns(db, table);
  for (const def of columnDefs) {
    const columnName = def.split(/\s+/)[0];
    if (existing.has(columnName)) continue;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
    existing.add(columnName);
  }
}

module.exports = {
  connect,
  createDb,
  createPool,
  ensureDatabase,
  existingColumns,
  existingIndexes,
  primaryKeyColumns,
  ensureColumns,
  DEFAULT_POOL_SIZE,
};
