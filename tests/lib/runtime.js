/**
 * Runtime harness for the contract guard.
 *
 * Starts a real backend on an isolated database and storage directory and
 * points the frontend's own axios instance at it. The user's live
 * `backend/data/dam.db` is never touched: the server is spawned with
 * `DB_PATH` and `STORAGE_DIR` pointing at a fresh temp directory.
 *
 * The frontend API modules are imported **as they are** — the same
 * `src/api/client.ts` the browser loads — so a broken contract fails here
 * instead of in production.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

/**
 * The repository root — two levels above `tests/lib/`.
 *
 * The backend reads its configuration from the `.env` file at the root, and
 * the guard starts the backend as a separate process, so the same file has
 * to be loaded here as well.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

/**
 * Minimal `localStorage` stand-in — the client module reads tokens from it.
 *
 * `location` is a plain object on purpose: the client's 401 handler assigns
 * `location.href`, and in a browser that would navigate. Here it must not.
 */
export function installBrowserGlobals() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
  globalThis.location = { pathname: '/', href: '' };
}

/**
 * Node's ESM resolver does not try extensions, and it knows nothing about the
 * `@/` alias the frontend uses. The frontend's API modules import each other
 * as `./client`, so teach the resolver to find `.ts` — and to turn `@/x` into
 * `<srcDir>/x`.
 *
 * `registerHooks` landed in Node 22.15, so the guard needs that or newer.
 * The repository declares no Node floor, which makes this the one place the
 * requirement is written down.
 *
 * @param {string} srcDir the frontend source root (`src/client`)
 */
export function installTypeScriptResolver(srcDir) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // The alias first: `@/api/tenants` is a real module, not a relative
      // path, and Node would not know where to look.
      if (specifier.startsWith('@/')) {
        const base = path.join(srcDir, specifier.slice(2));
        const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return nextResolve(specifier, context);
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (/\.[cm]?[jt]sx?$/.test(specifier)) throw error;
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          return nextResolve(`${specifier}.tsx`, context);
        }
      }
    },
  });
}

/**
 * Ask the OS for a port nobody is using.
 *
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `GET /api/health` until the server answers.
 *
 * The default budget is deliberately generous: the backend creates and
 * seeds a whole schema before it listens, and on a machine where a single
 * `CREATE TABLE` costs most of a second that is ~15 s of real work. A tight
 * timeout here produces a "did not become healthy" failure that says
 * nothing about the code.
 *
 * @param {number} port
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export async function waitForHealth(port, child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited early with code ${child.exitCode}: ${lastError}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = await response.json();
        if (body && body.status === 'ok') return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `health returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms: ${lastError}`);
}

/**
 * Spawn the backend against a throw-away database and storage directory.
 *
 * @param {{backendEntry: string}} input
 * @returns {Promise<{port: number, origin: string, child: import('node:child_process').ChildProcess,
 *                    tmpRoot: string, log: () => string, stop: () => Promise<void>}>}
 */
export async function startBackend({ backendEntry }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-contract-'));
  const storageDir = path.join(tmpRoot, 'storage');
  // The contract run gets its own schema on the MySQL server, so it never
  // touches the real library.
  const dbName = `dam_contract_${process.pid}_${Date.now().toString(36)}`;
  const port = await findFreePort();

  const child = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_NAME: dbName,
      STORAGE_DIR: storageDir,
      JWT_SECRET: 'contract-test-secret',
      // The sample library is a first-boot convenience — a contract run
      // wants a deterministic, empty library.
      SEED_SAMPLE_ASSETS: '0',
      // The webhook endpoints of the contract run point at the loopback
      // interface, which the delivery guard refuses — it exists to stop the
      // server being talked into reaching an address only it can see. The
      // switch is off by default; the guard itself has its own tests.
      WEBHOOK_ALLOW_PRIVATE_TARGETS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  const stop = async () => {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    await dropSchema(dbName);
    // A failed cleanup must not mask the real test result.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not remove the temp directory ${tmpRoot}:`, error);
    }
  };

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    child,
    tmpRoot,
    // The throw-away schema's name, so a check that needs to look at a row
    // where it lives can find it.
    dbName,
    log: () => serverLog,
    stop,
  };
}

/**
 * Run a query against the throw-away schema the contract run created.
 *
 * Some facts are only visible where the row lives: the tenant a row belongs
 * to is not in the DTO of a category, for instance. The check that needs it
 * asks here.
 *
 * @param {string} dbName the schema the contract run created
 * @param {string} sql the statement
 * @param {unknown[]} [params]
 * @returns {Promise<any[]>} the rows
 */
export async function queryTestDb(dbName, sql, params = []) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    const [rows] = await connection.query(sql, params);
    return rows;
  } finally {
    await connection.end();
  }
}

/**
 * Drop the throw-away schema the contract run created.
 *
 * @param {string} dbName
 * @returns {Promise<void>}
 */
async function dropSchema(dbName) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  } finally {
    await connection.end();
  }
}

/**
 * Import a frontend API module by its path under `src/`.
 *
 * @param {string} srcDir
 * @param {string} relativePath e.g. `api/client.ts`
 * @returns {Promise<any>}
 */
export async function importFrontendModule(srcDir, relativePath) {
  const absolute = path.join(srcDir, relativePath);
  return import(pathToFileURL(absolute).href);
}

/**
 * Perform a raw HTTP request against the test server.
 *
 * The frontend's axios instance is not used here on purpose: a rejected
 * axios call triggers the client's logout side effect, which would clear the
 * stored tokens and make the rest of the run meaningless.
 *
 * @param {string} origin
 * @param {string} method
 * @param {string} urlPath
 * @param {{headers?: Record<string, string>, body?: unknown}} [options]
 * @returns {Promise<{status: number, body: any}>}
 */
export async function rawRequest(origin, method, urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    if (typeof options.body === 'string') {
      body = options.body;
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    } else {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
  }
  const response = await fetch(`${origin}${urlPath}`, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

/**
 * Assert that a request fails with a specific HTTP status.
 *
 * @param {Promise<any>} promise
 * @param {number} expected
 * @param {string} label
 * @returns {Promise<any>} the rejection, so the caller can inspect the body
 */
export async function expectStatus(promise, expected, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (error === null) {
    assert.fail(`${label}: expected HTTP ${expected}, but the request succeeded`);
  }
  const status = error && error.response ? error.response.status : null;
  assert.equal(status, expected, `${label}: expected HTTP ${expected}, got ${status}`);
  return error;
}

/**
 * Bytes that are guaranteed not to collide with another upload.
 *
 * The backend de-duplicates uploads by file hash, so two "different" files
 * with identical bytes would come back as the same asset.
 *
 * @param {string} seed
 * @param {number} length
 * @returns {Buffer}
 */
export function uniqueBytes(seed, length) {
  const out = Buffer.alloc(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const block = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
    const take = Math.min(block.length, length - offset);
    block.copy(out, offset, 0, take);
    offset += take;
    counter += 1;
  }
  return out;
}

/**
 * @param {Buffer | string} value
 * @returns {string} the hex sha256 digest
 */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * A 1×1 PNG — the smallest thing sharp will accept.
 */
export const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * The frontend modules the runtime checks drive.
 *
 * @param {string} srcDir
 * @returns {Promise<Record<string, any>>}
 */
export async function loadFrontendApis(srcDir) {
  const [client, auth, assets, users, tags, categories, apikeys, webhooks, tenants, tenantStore, mcp, platform] =
    await Promise.all([
      importFrontendModule(srcDir, 'api/client.ts'),
      importFrontendModule(srcDir, 'api/auth.ts'),
      importFrontendModule(srcDir, 'api/assets.ts'),
      importFrontendModule(srcDir, 'api/users.ts'),
      importFrontendModule(srcDir, 'api/tags.ts'),
      importFrontendModule(srcDir, 'api/categories.ts'),
      importFrontendModule(srcDir, 'api/apikeys.ts'),
      importFrontendModule(srcDir, 'api/webhooks.ts'),
      importFrontendModule(srcDir, 'api/tenants.ts'),
      importFrontendModule(srcDir, 'stores/tenantStore.ts'),
      importFrontendModule(srcDir, 'api/mcp.ts'),
      importFrontendModule(srcDir, 'api/platform.ts'),
    ]);

  return {
    client,
    authApi: auth.authApi,
    assetsApi: assets.assetsApi,
    usersApi: users.usersApi,
    tagsApi: tags.tagsApi,
    categoriesApi: categories.categoriesApi,
    apiKeysApi: apikeys.apiKeysApi,
    webhooksApi: webhooks.webhooksApi,
    tenantsApi: tenants.tenantsApi,
    // The MCP tokens — the credential an AI client carries.
    mcpApi: mcp.mcpApi,
    // The platform layer — the desk one layer above the tenants.
    platformApi: platform.platformApi,
    // The tenant context store — the piece the UI picks a tenant through.
    tenantStore: tenantStore.useTenantStore,
    // The import / job helpers live outside the `assetsApi` object — they are
    // standalone functions in the same module.
    importUrlByUrl: assets.importUrlByUrl,
    lookupComfyUiJob: assets.lookupComfyUiJob,
    registerAssetByComfyJob: assets.registerAssetByComfyJob,
  };
}
