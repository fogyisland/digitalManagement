/**
 * Front ↔ back API contract guard.
 *
 * Run with `npm test` from `frontend/`. Two independent checks run back to
 * back; both must pass.
 *
 * ---------------------------------------------------------------------------
 * Part A — static route lint
 * ---------------------------------------------------------------------------
 * Every HTTP call site in `src/` is extracted and matched against the route
 * table parsed out of `backend/src/server.js`.
 *
 * The check that matters most: the axios instance in `src/api/client.ts`
 * already points at `/api/v1`, so a call site that *also* carries the prefix
 * would be sent to `/api/v1/api/v1/...` and answer 404. That was the state
 * of the whole legacy API layer — every login, list and upload silently
 * 404'd. A path that still carries the prefix is a hard failure here.
 *
 * Endpoints the backend does not implement yet are listed in
 * `KNOWN_BACKEND_GAPS` together with the reason. A *new* mismatch fails the
 * run; the known gaps stay visible in the summary instead of rotting into
 * undocumented surprises.
 *
 * ---------------------------------------------------------------------------
 * Part B — runtime integration
 * ---------------------------------------------------------------------------
 * A real backend is started on an isolated database and storage directory,
 * and the frontend's own `src/api/client.ts` / `src/api/assets.ts` are
 * imported and driven against it: login, token attach, authenticated reads
 * and a multipart upload using the backend's `files` field name.
 *
 * This is the part that would have caught the original double-prefix bug
 * and the `file` vs `files` multipart mismatch — both of which are silent
 * at compile time and fatal at runtime.
 *
 * The user's live `backend/data/dam.db` is never touched: the server is
 * spawned with `DB_PATH` and `STORAGE_DIR` pointing at a fresh temp dir.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(FRONTEND_DIR, '..');
const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src', 'server.js');
const SRC_DIR = path.join(FRONTEND_DIR, 'src');

/* ==========================================================================
   Part A — static route lint
   ========================================================================== */

/**
 * Endpoints the frontend calls that the backend does not serve (yet).
 *
 * Each entry is `METHOD /path` with the path relative to the `/api/v1` base
 * and every parameter collapsed to `:p`. The comment states why the gap
 * exists — it is a to-do list, not a whitelist of mistakes.
 */
const KNOWN_BACKEND_GAPS = new Map([
  // --- Session lifecycle: the backend issues a single 7-day bearer token ---
  ['POST /auth/refresh', 'backend issues one long-lived token; no refresh endpoint'],
  ['POST /auth/logout', 'stateless JWT — the client discards the token instead'],
  ['POST /auth/change-password', 'not implemented; Settings.tsx calls it'],

  // --- Tag / API-key updates: the backend only exposes create + list ------
  ['PUT /tags/:p', 'backend has no update route for tags'],
  ['DELETE /tags/:p', 'backend has no delete route for tags'],
  ['PUT /api-keys/:p', 'backend has no update route for api keys'],

  // --- Users: the backend has no user-management routes at all -----------
  ['GET /users', 'backend exposes no user management routes'],
  ['POST /users', 'backend exposes no user management routes'],
  ['PUT /users/:p', 'backend exposes no user management routes'],
  ['DELETE /users/:p', 'backend exposes no user management routes'],
  ['POST /users/:p/reset-password', 'backend exposes no user management routes'],

  // --- Trash / restore / download: assets are hard-deleted today ---------
  ['POST /assets/:p/restore', 'backend hard-deletes assets; no soft-delete yet'],
  ['POST /assets/:p/download', 'backend serves uploads from /storage directly'],

  // --- Chunked upload: only the single-shot endpoint exists ---------------
  ['POST /upload/init', 'chunked upload not implemented on the backend'],
  ['PUT /upload/chunk/:p', 'chunked upload not implemented on the backend'],
  ['POST /upload/complete', 'chunked upload not implemented on the backend'],

  // --- Import / job bookkeeping -------------------------------------------
  ['POST /assets/import-url', 'backend has no import-by-url route'],
  ['GET /jobs/by-comfyui/:p', 'backend has no jobs table or routes'],
  ['POST /assets/from-comfyui/:p', 'backend has no comfyui registration route'],
]);

/** Helper methods that map to an HTTP verb. */
const WRAPPER_METHODS = {
  apiGet: 'GET',
  apiPost: 'POST',
  apiPut: 'PUT',
  apiDelete: 'DELETE',
};

/** `axiosInstance.<verb>(...)` — the shared `apiClient` and its `http` alias. */
const INSTANCE_METHODS = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/* --- Source scanning helpers -------------------------------------------- */

/**
 * Replace every comment body and string body with spaces, keeping the
 * original length. Scanning the masked source means a path mentioned in a
 * comment is never mistaken for a call site, while the literal contents can
 * still be read back from the original file.
 */
function maskSource(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipQuoted(source, i);
      // Keep the delimiters, blank the body.
      out += source[i];
      for (let k = i + 1; k < end - 1; k += 1) out += source[k] === '\n' ? '\n' : ' ';
      if (end - 1 > i) out += source[end - 1];
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Return the index just past the quoted literal that starts at `start`.
 * Handles `'`, `"` and backtick templates (including `${}` holes).
 */
function skipQuoted(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`') {
      if (ch === '`') return i + 1;
      if (ch === '$' && source[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < source.length && depth > 0) {
          const c = source[i];
          if (c === "'" || c === '"') {
            i = skipQuoted(source, i);
            continue;
          }
          if (c === '`') {
            i = skipQuoted(source, i);
            continue;
          }
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          i += 1;
        }
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

/**
 * Read the balanced range between the bracket at `openIndex` and its match.
 * Returns `{ start, end }` — the half-open span of the inner content.
 */
function readBalancedRange(source, openIndex) {
  const open = source[openIndex];
  const close = open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { start: openIndex + 1, end: i };
    }
  }
  return null;
}

/**
 * Find the index just past a generic argument list (`<PageResponse<T>>`).
 *
 * The angle depth is tracked with `<` / `>`; `=>` is skipped so an arrow
 * function inside a type argument does not close the list early.
 */
function findGenericEnd(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '<') depth += 1;
    else if (ch === '=' && source[i + 1] === '>') i += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Find the opening parenthesis of a call, skipping whitespace and an
 * optional generic argument list. Returns `null` when there is no call.
 */
function findCallOpenParen(source, from) {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] === '<') {
    const end = findGenericEnd(source, i);
    if (end === null) return null;
    i = end;
    while (i < source.length && /\s/.test(source[i])) i += 1;
  }
  return source[i] === '(' ? i : null;
}

/**
 * Read the first argument of a call. Returns `null` when the argument is
 * not a plain string literal (a variable, a function call, …) — those call
 * sites cannot be checked statically and are skipped.
 */
function readFirstArgument(original, masked, argsStart) {
  const range = readBalancedRange(masked, argsStart);
  if (range === null) return null;
  const maskedArgs = masked.slice(range.start, range.end);
  const trimmed = maskedArgs.trim();
  if (trimmed.length === 0) return null;
  const offset = maskedArgs.indexOf(trimmed[0]);
  const valueStart = range.start + offset;
  const quote = original[valueStart];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const end = skipQuoted(original, valueStart);
  const raw = original.slice(valueStart + 1, end - 1);
  return { raw, isTemplate: quote === '`' };
}

/**
 * Read `key: value` out of an object literal. Returns `null` when the value
 * is not a string literal.
 *
 * `maskedText` and `originalText` are the same span of the file — the masked
 * copy has string bodies blanked, the original keeps them. Offsets align.
 */
function readObjectValue(maskedText, originalText, key) {
  const re = new RegExp(`(^|[^\\w$])${key}\\s*:`, 'g');
  const match = re.exec(maskedText);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (i < maskedText.length && /\s/.test(maskedText[i])) i += 1;
  const quote = originalText[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const end = skipQuoted(originalText, i);
  return { raw: originalText.slice(i + 1, end - 1), isTemplate: quote === '`' };
}

/** Recursively collect every `.ts` / `.tsx` file below `dir`. */
function collectSourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Collapse a path to the shape used for comparison:
 * query string removed, parameters unified to `:p`.
 */
function normalizePath(rawPath, isTemplate) {
  let value = rawPath.split('?')[0];
  if (isTemplate) value = value.replace(/\$\{[^}]*\}/g, ':p');
  return value.replace(/:[A-Za-z_][\w]*/g, ':p').replace(/\/+$/, '') || '/';
}

/** Strip the `/api/v1` prefix the axios baseURL already carries. */
function stripBasePrefix(value) {
  if (value === '/api/v1') return '/';
  if (value.startsWith('/api/v1/')) return value.slice('/api/v1'.length);
  return value;
}

/**
 * Parse the backend route table out of `backend/src/server.js`.
 *
 * Routes are stored relative to the `/api/v1` base so they can be compared
 * with the frontend's relative paths: `GET /api/v1/categories` is stored as
 * `GET /categories`. Routes outside that namespace (`/api/health`,
 * `/api/public/v1/...`) keep their full path.
 *
 * @returns {Map<string, string>} `METHOD /path` → the original route.
 */
function parseBackendRoutes() {
  const source = fs.readFileSync(BACKEND_SRC, 'utf8');
  const masked = maskSource(source);
  const routes = new Map();
  const re = /\bapp\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const method = match[1].toUpperCase();
    const quoteIndex = match.index + match[0].length - 1;
    const end = skipQuoted(source, quoteIndex);
    const raw = source.slice(quoteIndex + 1, end - 1);
    const relative = stripBasePrefix(normalizePath(raw, false));
    routes.set(`${method} ${relative}`, raw);
  }
  return routes;
}

/**
 * Extract every statically-checkable HTTP call site under `src/`.
 * @returns {Array<{file: string, line: number, method: string, rawPath: string, path: string}>}
 */
function parseFrontendCallSites() {
  const sites = [];

  for (const file of collectSourceFiles(SRC_DIR)) {
    const original = fs.readFileSync(file, 'utf8');
    const masked = maskSource(original);
    const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');

    const record = (index, method, rawPath, isTemplate) => {
      const line = original.slice(0, index).split('\n').length;
      sites.push({
        file: relative,
        line,
        method,
        rawPath,
        path: normalizePath(rawPath, isTemplate),
      });
    };

    // --- `apiGet('/x')`, `apiPost('/x')`, … -----------------------------
    for (const [name, method] of Object.entries(WRAPPER_METHODS)) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      let match;
      while ((match = re.exec(masked)) !== null) {
        const parenIndex = findCallOpenParen(masked, match.index + name.length);
        if (parenIndex === null) continue;
        const arg = readFirstArgument(original, masked, parenIndex);
        if (arg === null) continue;
        record(match.index, method, arg.raw, arg.isTemplate);
      }
    }

    // --- `apiClient.get('/x')`, `http.post('/x')`, … ---------------------
    const instanceRe = /\b(apiClient|http)\s*\.\s*(get|post|put|patch|delete)\b/g;
    let instanceMatch;
    while ((instanceMatch = instanceRe.exec(masked)) !== null) {
      const method = INSTANCE_METHODS[instanceMatch[2]];
      const parenIndex = findCallOpenParen(masked, instanceMatch.index + instanceMatch[0].length);
      if (parenIndex === null) continue;
      const arg = readFirstArgument(original, masked, parenIndex);
      if (arg === null) continue;
      record(instanceMatch.index, method, arg.raw, arg.isTemplate);
    }

    // --- `apiClient.request({ url, method })` ---------------------------
    const requestRe = /\bapiClient\s*\.\s*request\b/g;
    let requestMatch;
    while ((requestMatch = requestRe.exec(masked)) !== null) {
      const parenIndex = findCallOpenParen(masked, requestMatch.index + requestMatch[0].length);
      if (parenIndex === null) continue;
      const argsRange = readBalancedRange(masked, parenIndex);
      if (argsRange === null) continue;
      const argsMasked = masked.slice(argsRange.start, argsRange.end);
      const argsOriginal = original.slice(argsRange.start, argsRange.end);
      const braceOffset = argsMasked.indexOf('{');
      if (braceOffset === -1) continue;
      const objectRange = readBalancedRange(argsMasked, braceOffset);
      if (objectRange === null) continue;
      const objectMasked = argsMasked.slice(objectRange.start, objectRange.end);
      const objectOriginal = argsOriginal.slice(objectRange.start, objectRange.end);
      const urlValue = readObjectValue(objectMasked, objectOriginal, 'url');
      if (urlValue === null) continue;
      const methodValue = readObjectValue(objectMasked, objectOriginal, 'method');
      // A dynamic method cannot be checked statically.
      if (methodValue === null && /\bmethod\s*:/.test(objectMasked)) continue;
      const method = methodValue === null ? 'GET' : methodValue.raw.toUpperCase();
      if (!HTTP_METHODS.has(method)) continue;
      record(requestMatch.index, method, urlValue.raw, urlValue.isTemplate);
    }

    // --- `useApi('/x')` — always a GET ----------------------------------
    const useApiRe = /\buseApi\b/g;
    let useApiMatch;
    while ((useApiMatch = useApiRe.exec(masked)) !== null) {
      const parenIndex = findCallOpenParen(masked, useApiMatch.index + 'useApi'.length);
      if (parenIndex === null) continue;
      const arg = readFirstArgument(original, masked, parenIndex);
      if (arg === null) continue;
      record(useApiMatch.index, 'GET', arg.raw, arg.isTemplate);
    }
  }

  return sites;
}

/** Run Part A. */
function runStaticLint() {
  const routes = parseBackendRoutes();
  const sites = parseFrontendCallSites();
  const violations = [];

  for (const site of sites) {
    const where = `${site.file}:${site.line}`;

    if (site.method === 'PATCH') {
      violations.push(`${where} uses PATCH — the backend serves no PATCH route`);
      continue;
    }

    if (site.rawPath.startsWith('/api/v1')) {
      violations.push(
        `${where} path "${site.rawPath}" still carries the /api/v1 prefix — ` +
          'the axios instance already points there, so the request resolves to ' +
          `/api/v1${site.rawPath} and answers 404`,
      );
      continue;
    }

    const relative = stripBasePrefix(site.path);
    const key = `${site.method} ${relative}`;
    if (routes.has(key)) continue;

    if (KNOWN_BACKEND_GAPS.has(key)) continue;

    violations.push(`${where} ${site.method} ${site.path} — no matching backend route`);
  }

  // The base URL is the contract's anchor: pin it so a "quick fix" cannot
  // silently move the whole API under a different prefix.
  const clientSource = fs.readFileSync(path.join(SRC_DIR, 'api', 'client.ts'), 'utf8');
  const baseUrlMatch = /baseURL\s*:\s*(['"`])([^'"`]+)\1/.exec(clientSource);
  if (baseUrlMatch === null) {
    violations.push('src/api/client.ts — no baseURL found on the shared axios instance');
  } else if (baseUrlMatch[2] !== '/api/v1') {
    violations.push(
      `src/api/client.ts baseURL is "${baseUrlMatch[2]}" — expected "/api/v1"`,
    );
  }

  assert.deepEqual(
    violations,
    [],
    `API contract lint failed:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
  );

  const usedGaps = new Set(
    sites
      .map((site) => `${site.method} ${stripBasePrefix(site.path)}`)
      .filter((key) => KNOWN_BACKEND_GAPS.has(key)),
  );

  console.log(
    `static route lint OK — ${sites.length} call sites checked against ${routes.size} backend routes`,
  );
  if (usedGaps.size > 0) {
    console.log(`known backend gaps still open (${usedGaps.size}):`);
    for (const key of [...usedGaps].sort()) {
      console.log(`  - ${key} — ${KNOWN_BACKEND_GAPS.get(key)}`);
    }
  }
  return { sites, routes };
}

/* ==========================================================================
   Part B — runtime integration
   ========================================================================== */

/** Minimal `localStorage` stand-in — the client module reads tokens from it. */
function installBrowserGlobals() {
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
 * Node's ESM resolver does not try extensions. The frontend's API modules
 * import each other as `./client`, so teach the resolver to find `.ts`.
 */
function installTypeScriptResolver() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
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

/** Ask the OS for a port nobody is using. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `GET /api/health` until the server answers. */
async function waitForHealth(port, child, timeoutMs = 20000) {
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

/** A 1×1 PNG — the smallest thing sharp will accept. */
const TINY_PNG = Buffer.from([
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

/** Run Part B. */
async function runRuntimeIntegration() {
  installBrowserGlobals();
  installTypeScriptResolver();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-contract-'));
  const dbPath = path.join(tmpRoot, 'contract.db');
  const storageDir = path.join(tmpRoot, 'storage');
  const port = await findFreePort();

  const child = spawn(process.execPath, [BACKEND_SRC], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      STORAGE_DIR: storageDir,
      JWT_SECRET: 'contract-test-secret',
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

  try {
    await waitForHealth(port, child);

    const client = await import(pathToFileURL(path.join(SRC_DIR, 'api', 'client.ts')).href);
    const authApi = await import(pathToFileURL(path.join(SRC_DIR, 'api', 'auth.ts')).href);
    const assetsModule = await import(pathToFileURL(path.join(SRC_DIR, 'api', 'assets.ts')).href);

    // The browser resolves the relative baseURL against the page origin; in
    // Node we point the very same instance at the test server.
    client.apiClient.defaults.baseURL = `http://127.0.0.1:${port}/api/v1`;

    // --- 1) Login --------------------------------------------------------
    const login = await authApi.authApi.login('admin', 'Admin@123456');
    assert.ok(typeof login.access_token === 'string' && login.access_token.length > 0,
      'login must return an access token');
    assert.equal(login.user.username, 'admin', 'login must echo the user');

    // --- 2) The token must reach the server as a bearer header ----------
    client.setToken(login.access_token);
    assert.equal(client.getToken(), login.access_token, 'setToken must be readable back');
    const me = await client.apiGet('/auth/me');
    assert.equal(me.username, 'admin', '/auth/me must see the bearer token');

    // --- 3) The list endpoints the pages load on boot --------------------
    const assets = await client.apiGet('/assets');
    assert.ok(Array.isArray(assets.items), '/assets must return an items array');
    assert.equal(typeof assets.total, 'number', '/assets must return a total');

    const categories = await client.apiGet('/categories');
    assert.ok(Array.isArray(categories), '/categories must return an array');

    const tags = await client.apiGet('/tags');
    assert.ok(Array.isArray(tags), '/tags must return an array');

    const stats = await client.apiGet('/stats');
    assert.equal(typeof stats.total, 'number', '/stats must return counters');

    // --- 4) Multipart upload uses the backend's `files` field -----------
    const file = new File([TINY_PNG], 'contract-test.png', { type: 'image/png' });
    const uploaded = await assetsModule.assetsApi.upload(file, { title: 'contract-test' });
    assert.equal(uploaded.count, 1, 'upload must report one stored file');
    assert.equal(uploaded.items.length, 1, 'upload must echo the stored asset');
    assert.equal(uploaded.items[0].asset_type, 'image', 'upload must detect the asset type');
    assert.equal(uploaded.items[0].title, 'contract-test.png',
      'upload must store the original file name as title');

    // --- 5) A prefixed path must miss — the double-prefix guard ----------
    await assert.rejects(
      () => client.apiGet('/api/v1/assets'),
      (error) => {
        const status = error && error.response ? error.response.status : null;
        assert.equal(status, 404,
          'a path that still carries /api/v1 must resolve to /api/v1/api/v1/... and answer 404');
        return true;
      },
      'the double-prefix guard must reject the prefixed path',
    );

    console.log('runtime integration OK — login, token attach, list and upload verified');
  } catch (error) {
    console.error('--- backend log ---');
    console.error(serverLog.trim());
    throw error;
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    // Windows keeps the SQLite handle locked for a moment after the process
    // exits; a failed cleanup must not mask the real test result.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not remove the temp directory ${tmpRoot}:`, error);
    }
  }
}

/* ==========================================================================
   Entry point
   ========================================================================== */

async function main() {
  runStaticLint();
  await runRuntimeIntegration();
  console.log('\nAll contract checks passed.');
}

main().catch((error) => {
  console.error('\nContract check failed:');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
