/**
 * Runtime contract checks — how the instance serves its own front end.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner. These checks live outside that array on purpose: they need
 * the **built** front end, and the suite must still run on a tree that has
 * never been built. When `dist/` is missing the whole group says so and steps
 * aside — it never pretends to have checked anything.
 *
 * The instance serves one port for everything, so the same process that
 * answers the API also answers the pages. That makes the delivery of the front
 * end part of the contract, and there are two ways it used to break:
 *
 *   - The shell was cached like everything else. The shell is the file that
 *     *names* the hashed chunks, so a cached copy of it points at chunks the
 *     next build deleted — and the application then dies with "Failed to fetch
 *     dynamically imported module", a message that names the network rather
 *     than the stale page. The shell is revalidated on every use; the chunks
 *     themselves keep their long cache, because their name changes when their
 *     content does.
 *
 *   - The fallback answered *every* path with the shell, including the ones
 *     that look like a file. A chunk that had been deleted was answered with
 *     200 and a page of HTML, so the browser reported a failed dynamic import
 *     instead of an honest 404 — and the fallback had to guess, from the
 *     shape of the path, whether it was looking at a route or at a file.
 *
 * The rule the fallback follows: a path that looks like a file is not a
 * route. `/login` and even `/assets/upload` are routes and get the shell; a
 * chunk that is gone gets a 404.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { rawRequest } from './runtime.js';

/** The mark the shell leaves behind, so that a 200 carrying something else is not the shell. */
const SHELL_MARK = 'id="root"';

/** How long a chunk is worth caching for. The chunks are named after their content. */
const CHUNK_CACHE_SECONDS = 3600;

/**
 * How long a response may be reused without asking again, in seconds.
 *
 * `Infinity` means nothing in the header limits the reuse. `no-cache` and
 * `no-store` mean the answer may not be reused at all — `no-cache` allows the
 * browser to keep a copy but makes it ask before using it, which is exactly
 * what the shell needs.
 *
 * `must-revalidate` is deliberately not counted: it says what happens *after*
 * an answer goes stale, not how long a fresh one stays fresh. A header of
 * `public, max-age=3600, must-revalidate` is still an hour of reuse.
 *
 * @param {string|undefined} cacheControl the `Cache-Control` header
 * @returns {number} the seconds the answer may be reused without asking
 */
export function reusableFor(cacheControl) {
  if (!cacheControl) return Infinity;
  const value = cacheControl.toLowerCase();
  if (value.includes('no-store') || value.includes('no-cache')) return 0;
  const limits = [];
  const maxAge = /max-age\s*=\s*(\d+)/.exec(value);
  if (maxAge) limits.push(Number(maxAge[1]));
  const sMaxAge = /s-maxage\s*=\s*(\d+)/.exec(value);
  if (sMaxAge) limits.push(Number(sMaxAge[1]));
  return limits.length ? Math.min(...limits) : Infinity;
}

/**
 * The chunk the shell loads — the one the browser asks for first.
 *
 * @param {string} shell the contents of `dist/index.html`
 * @returns {string|null} the path of the entry chunk
 */
function entryChunkOf(shell) {
  const match = /src="(\/assets\/[^"]+\.js)"/.exec(shell);
  return match ? match[1] : null;
}

/**
 * The content type of a response, without its parameters.
 *
 * @param {Record<string, string>} headers
 * @returns {string}
 */
function contentTypeOf(headers) {
  return (headers['content-type'] || '').split(';')[0].trim();
}

/**
 * Run the static hosting checks against a running instance.
 *
 * @param {{origin: string, distDir: string}} input
 * @returns {Promise<{skipped: boolean, reason: string, passed: string[]}>}
 */
export async function runStaticHostingChecks({ origin, distDir }) {
  const shellPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(shellPath)) {
    return {
      skipped: true,
      reason: `no frontend build in ${distDir} — run "npm run build" first`,
      passed: [],
    };
  }

  const shell = fs.readFileSync(shellPath, 'utf8');
  const passed = [];

  /**
   * Run one check and record it.
   *
   * @param {string} name
   * @param {() => Promise<void>} body
   */
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`static hosting check "${name}" failed: ${message}`, { cause: error });
    }
    passed.push(name);
  };

  await check('the shell is served, and it is never reused without asking', async () => {
    const response = await rawRequest(origin, 'GET', '/');
    assert.equal(response.status, 200, 'the root must answer with the shell');
    assert.ok(
      String(response.body).includes(SHELL_MARK),
      'the root must answer with the built shell, not with a placeholder',
    );
    const reusable = reusableFor(response.headers['cache-control']);
    assert.equal(
      reusable,
      0,
      `the shell names the chunks, so a cached copy of it points at files that may be gone; ` +
        `its Cache-Control was "${response.headers['cache-control'] || '(none)'}"`,
    );
  });

  await check('a route of the application is answered with the shell, uncached', async () => {
    for (const route of ['/login', '/assets/upload']) {
      const response = await rawRequest(origin, 'GET', route);
      assert.equal(response.status, 200, `${route} is a route of the application and must be answered`);
      assert.ok(
        String(response.body).includes(SHELL_MARK),
        `${route} must be answered with the shell, not with ${contentTypeOf(response.headers)}`,
      );
      const reusable = reusableFor(response.headers['cache-control']);
      assert.equal(
        reusable,
        0,
        `${route} answers with the shell, so it must be revalidated on every use; ` +
          `its Cache-Control was "${response.headers['cache-control'] || '(none)'}"`,
      );
    }
  });

  await check('a chunk is served, and it is worth caching', async () => {
    const chunk = entryChunkOf(shell);
    assert.ok(chunk, 'the shell must name the chunk it loads');
    const response = await rawRequest(origin, 'GET', chunk);
    assert.equal(response.status, 200, `${chunk} must be served`);
    const reusable = reusableFor(response.headers['cache-control']);
    assert.ok(
      reusable >= CHUNK_CACHE_SECONDS,
      `a chunk is named after its content, so it may be cached for a long time; ` +
        `${chunk} was cached for ${reusable}s`,
    );
  });

  await check('a chunk that is gone answers 404, not the shell', async () => {
    const response = await rawRequest(origin, 'GET', '/assets/no-such-chunk-0000.js');
    assert.equal(
      response.status,
      404,
      'a file that is not there must answer 404 — answering with the shell turns a missing ' +
        'chunk into a failed dynamic import in the browser',
    );
    assert.ok(
      !String(response.body).includes(SHELL_MARK),
      'the answer to a missing chunk must not be the shell',
    );
  });

  await check('an unknown API path answers the API, not the shell', async () => {
    const response = await rawRequest(origin, 'GET', '/api/no-such-endpoint');
    assert.equal(response.status, 404, 'an unknown API path must answer 404');
    assert.equal(
      contentTypeOf(response.headers),
      'application/json',
      'an unknown API path must answer JSON — the page fallback must not swallow it',
    );
    assert.equal(response.body?.detail, 'Not found', 'the API answers with its own shape');
  });

  return { skipped: false, reason: '', passed };
}
