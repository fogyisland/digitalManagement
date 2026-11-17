#!/usr/bin/env node

/**
 * Verify the release bundle in `up/` — by actually running it.
 *
 * A bundle that has never been started is a bundle nobody knows anything
 * about. This script does three things:
 *
 *   1. integrity   — every file matches the SHA-256 in `SHA256SUMS`
 *   2. completeness — the files the application needs at run time are there
 *   3. behaviour   — the bundle is started on its own port, against its own
 *                    throw-away schema, and asked the questions that matter:
 *                    does the API answer, does the shell load, does a deep
 *                    link load, is the shell uncached, is a chunk cached, and
 *                    does a chunk that is *gone* answer 404 rather than the
 *                    shell.
 *
 * The server is started from `up/` itself, so `ROOT_DIR` resolves inside the
 * bundle — which is the whole point: it proves the bundle is self-contained
 * rather than accidentally reading the repository it was cut from.
 *
 * Usage:
 *   node scripts/release/verify-release.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..', '..');
const BUNDLE_DIR = path.join(ROOT_DIR, 'up');

/** The schema the verification run uses. It is dropped when the run ends. */
const TEST_SCHEMA = `dam_release_verify_${process.pid}`;

/** Where the verification run keeps its files. */
const TEST_STORAGE = path.join(
  process.env.TEMP || process.env.TMP || '/tmp',
  `dam-release-verify-${process.pid}`,
);

/**
 * The files the application cannot start without.
 *
 * The list is not a guess: `src/server/server.js` resolves the frontend build
 * at `ROOT_DIR/dist`, the API document at `src/server/openapi.yaml`, and
 * Node resolves the dependencies through `package.json` + `package-lock.json`.
 */
const REQUIRED = [
  'package.json',
  'package-lock.json',
  '.env.example',
  'dist/index.html',
  'src/server/server.js',
  'src/server/openapi.yaml',
  'scripts/create-database.sql',
  'docs/DEPLOY-NGINX.md',
  'start.sh',
  'nginx.conf.example',
  'DEPLOY.md',
  'SHA256SUMS',
  'MANIFEST.txt',
];

let failures = 0;
let checks = 0;

/**
 * Record one check.
 *
 * @param {boolean} ok whether it passed
 * @param {string} what what was checked
 * @param {string} [detail] extra context when it failed
 */
function check(ok, what, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ''}`);
  }
}

/**
 * Find a free TCP port on the loopback interface.
 *
 * @returns {Promise<number>} the port
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Wait for the server to answer its health check.
 *
 * @param {string} base the base URL
 * @param {number} timeoutMs how long to wait
 * @returns {Promise<boolean>} whether it came up
 */
async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/**
 * Read the database credentials the repository's own `.env` holds.
 *
 * The verification run needs a MySQL account that may create a schema; the
 * repository's `.env` is where that account is configured.
 *
 * @returns {Record<string, string>} the variables the server needs
 */
function readRepoEnv() {
  const envFile = path.join(ROOT_DIR, '.env');
  const out = {};
  if (!fs.existsSync(envFile)) return out;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Drop the throw-away schema.
 *
 * @param {Record<string, string>} env the database settings
 */
async function dropSchema(env) {
  const mysql = await import('mysql2/promise').catch(() => null);
  if (!mysql) return;
  const connection = await mysql.createConnection({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${TEST_SCHEMA}\``);
  } finally {
    await connection.end();
  }
}

/**
 * Fetch something and report what came back.
 *
 * @param {string} url the URL
 * @returns {Promise<{status: number, type: string, body: string, headers: Headers}>}
 */
async function probe(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    type: response.headers.get('content-type') || '',
    body: await response.text(),
    headers: response.headers,
  };
}

async function main() {
  console.log('');
  console.log('=== 1. integrity ===');
  const sumsFile = path.join(BUNDLE_DIR, 'SHA256SUMS');
  if (!fs.existsSync(sumsFile)) {
    check(false, 'SHA256SUMS is there', 'the bundle was not built');
    process.exit(1);
  }
  const lines = fs.readFileSync(sumsFile, 'utf8').trim().split(/\r?\n/);
  let mismatched = 0;
  let missing = 0;
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
    if (!match) continue;
    const [, digest, relative] = match;
    const absolute = path.join(BUNDLE_DIR, relative);
    if (!fs.existsSync(absolute)) {
      missing += 1;
      continue;
    }
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(absolute))
      .digest('hex');
    if (actual !== digest) mismatched += 1;
  }
  check(missing === 0, `every file in SHA256SUMS exists (${lines.length} files)`);
  check(mismatched === 0, 'every file matches its SHA-256');

  console.log('');
  console.log('=== 2. completeness ===');
  for (const relative of REQUIRED) {
    check(fs.existsSync(path.join(BUNDLE_DIR, relative)), `${relative} is in the bundle`);
  }
  check(
    !fs.existsSync(path.join(BUNDLE_DIR, 'node_modules')),
    'node_modules is NOT in the bundle (it is installed on the target)',
  );
  check(
    !fs.existsSync(path.join(BUNDLE_DIR, '.env')),
    '.env is NOT in the bundle (it holds the secrets)',
  );
  const storageDirs = ['originals', 'thumbnails', 'previews', 'temp', 'manifests', 'placeholders'];
  const missingStorage = storageDirs.filter(
    (dir) => !fs.existsSync(path.join(BUNDLE_DIR, 'storage', dir)),
  );
  check(missingStorage.length === 0, 'the storage skeleton is complete', missingStorage.join(', '));

  console.log('');
  console.log('=== 3. behaviour ===');

  const repoEnv = readRepoEnv();
  if (!repoEnv.DB_PASSWORD) {
    console.log('  SKIP  the behaviour run — no DB_PASSWORD in the repository .env');
    console.log('');
    report();
    return;
  }

  const port = await findFreePort();
  fs.mkdirSync(TEST_STORAGE, { recursive: true });

  const child = spawn(process.execPath, ['src/server/server.js'], {
    cwd: BUNDLE_DIR,
    env: {
      ...process.env,
      ...repoEnv,
      ENV_FILE: path.join(ROOT_DIR, '.env'),
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_NAME: TEST_SCHEMA,
      STORAGE_DIR: TEST_STORAGE,
      SEED_SAMPLE_ASSETS: '0',
      JWT_SECRET: 'release-verification-secret-not-for-production',
      TRUST_PROXY: 'off',
      NODE_ENV: 'production',
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

  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  try {
    healthy = await waitForHealth(base, 60000);
  } catch {
    healthy = false;
  }

  if (!healthy) {
    check(false, 'the bundle starts and answers /api/health', serverLog.slice(-2000));
    child.kill();
    await dropSchema({ ...repoEnv, DB_NAME: TEST_SCHEMA });
    report();
    return;
  }
  check(true, 'the bundle starts and answers /api/health');

  const health = await probe(`${base}/api/health`);
  check(health.status === 200, 'GET /api/health answers 200');

  const shell = await probe(`${base}/`);
  check(shell.status === 200, 'GET / answers 200');
  check(shell.type.includes('text/html'), 'the shell is HTML', `content-type: ${shell.type}`);
  check(shell.body.includes('<div id="root"'), 'the shell carries the root element');
  const shellCache = shell.headers.get('cache-control') || '';
  check(
    shellCache.includes('no-cache'),
    'the shell is not cached',
    `cache-control: ${shellCache || '(none)'}`,
  );

  const deep = await probe(`${base}/organize`);
  check(deep.status === 200, 'a deep link answers 200 (not 404)');
  check(deep.type.includes('text/html'), 'a deep link answers with the shell');

  const assetsDir = path.join(BUNDLE_DIR, 'dist', 'assets');
  const chunkName = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).find((name) => name.endsWith('.js'))
    : null;
  if (chunkName) {
    const chunk = await probe(`${base}/assets/${chunkName}`);
    check(chunk.status === 200, `the chunk ${chunkName} answers 200`);
    const chunkCache = chunk.headers.get('cache-control') || '';
    const maxAge = /max-age=(\d+)/.exec(chunkCache);
    check(
      Boolean(maxAge) && Number(maxAge[1]) >= 3600,
      'the chunk is cached for a long time',
      `cache-control: ${chunkCache || '(none)'}`,
    );
  } else {
    check(false, 'there is a chunk in dist/assets to check');
  }

  const gone = await probe(`${base}/assets/there-is-no-such-chunk.js`);
  check(gone.status === 404, 'a chunk that is gone answers 404', `status: ${gone.status}`);
  // The invariant is not "the 404 is not HTML" — Express's own 404 page is HTML,
  // and so is nginx's `=404`. The invariant is that the answer is **not the
  // shell**: a 200 carrying the shell would make the browser report a failed
  // dynamic import instead of an honest 404.
  check(
    !gone.body.includes('<div id="root"'),
    'a chunk that is gone does not answer with the shell',
    `body: ${gone.body.slice(0, 120)}`,
  );
  check(
    gone.body.length < 4096,
    'the 404 body is a short notice, not a page',
    `body length: ${gone.body.length}`,
  );

  const docs = await probe(`${base}/docs`);
  check(docs.status === 200, 'GET /docs answers 200 (the API document is served)');

  const openapi = await probe(`${base}/openapi.json`);
  check(openapi.status === 200, 'GET /openapi.json answers 200');

  const mcp = await probe(`${base}/mcp`);
  check(mcp.status !== 404, 'GET /mcp is not 404 (the MCP route is claimed)', `status: ${mcp.status}`);

  const unauth = await probe(`${base}/api/v1/assets`);
  check(unauth.status === 401, 'an unauthenticated API call is refused', `status: ${unauth.status}`);
  check(
    unauth.type.includes('json'),
    'the refusal is JSON, not a page',
    `content-type: ${unauth.type}`,
  );

  child.kill();
  await dropSchema({ ...repoEnv, DB_NAME: TEST_SCHEMA });
  fs.rmSync(TEST_STORAGE, { recursive: true, force: true });

  report();
}

function report() {
  console.log('');
  if (failures === 0) {
    console.log(`the bundle is good — ${checks} checks passed`);
  } else {
    console.log(`${failures} of ${checks} checks FAILED`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
