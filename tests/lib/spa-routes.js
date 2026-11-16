/**
 * The pages the SPA owns, and the paths the server has already claimed.
 *
 * The server mounts its routers *before* the frontend's catch-all, so a path a
 * router owns belongs to that router — the SPA never sees it. A page whose
 * path sits under such a mount works exactly once: the click that routes
 * client-side. The reload after it answers with the router's own response —
 * a 405 for a POST-only endpoint like MCP's, or a JSON body where a page was
 * expected.
 *
 * Both sides are read from the source: the pages from `src/client/router.tsx`,
 * the claims from the mounts `server.js` registers. An overlap is a page that
 * cannot be reloaded, bookmarked or shared — so it fails the build here rather
 * than in front of a user.
 *
 * The router's path-bearing routes are read as they are written: an absolute
 * path (`'/login'`) is used as it stands, a relative one (`'library'`) is
 * rooted at the root layout, which is the only parent that carries a path.
 * A layout with a path of its own would need the parser to grow a prefix
 * stack; the fixtures below are what keeps that assumption honest.
 */

import fs from 'node:fs';

import { maskSource, readLiteralAt } from './source-scan.js';

/**
 * The SPA's own pages.
 *
 * The catch-all (`path: '*'`) is left out: it answers whatever no other route
 * claimed, so it can never collide with a mount.
 *
 * @param {{routerFile: string}} input
 * @returns {Array<{path: string, line: number}>} the page paths, absolute
 */
export function parseSpaRoutes({ routerFile }) {
  const source = fs.readFileSync(routerFile, 'utf8');
  const masked = maskSource(source);
  const routes = [];

  // `path:` only counts where it opens an object literal — a key in a route
  // definition, not a word that happens to appear in an expression.
  const pathRe = /(^|[{,])\s*path\s*:\s*(['"`])/g;
  let match;
  while ((match = pathRe.exec(masked)) !== null) {
    const quoteIndex = match.index + match[0].length - 1;
    const literal = readLiteralAt(source, quoteIndex);
    if (literal === null || literal.isTemplate) continue;
    const raw = literal.raw.trim();
    if (raw === '' || raw === '*') continue;
    routes.push({
      path: raw.startsWith('/') ? raw : `/${raw}`,
      line: source.slice(0, match.index).split('\n').length,
    });
  }

  // The index route is a page too — it is the dashboard.
  const indexRe = /(^|[{,])\s*index\s*:\s*true\b/g;
  while ((match = indexRe.exec(masked)) !== null) {
    routes.push({
      path: '/',
      line: source.slice(0, match.index).split('\n').length,
    });
  }

  return routes;
}

/**
 * The mounted paths a router has claimed.
 *
 * A mount claims the prefix itself and everything below it: `app.use('/mcp')`
 * answers `/mcp` and `/mcp/anything`, but not `/mcpx`.
 *
 * @param {Array<{prefix: string|null}>} mounts
 * @returns {string[]} the claimed prefixes
 */
export function claimedPrefixes(mounts) {
  const prefixes = [];
  for (const mount of mounts) {
    if (!mount.prefix) continue;
    if (!prefixes.includes(mount.prefix)) prefixes.push(mount.prefix);
  }
  return prefixes;
}

/**
 * Pages that sit on a path the server has already claimed.
 *
 * @param {{spaRoutes: Array<{path: string, line: number}>, mounts: Array<{prefix: string|null}>, routerLabel?: string}} input
 * @returns {string[]} one line per collision, empty when the two sides agree
 */
export function findSpaRouteCollisions({ spaRoutes, mounts, routerLabel = 'the router' }) {
  const problems = [];
  for (const route of spaRoutes) {
    for (const prefix of claimedPrefixes(mounts)) {
      if (route.path !== prefix && !route.path.startsWith(`${prefix}/`)) continue;
      problems.push(
        `${routerLabel}:${route.line} serves the page "${route.path}", but the server ` +
          `mounts a router on "${prefix}" — the server answers that path first, so the page ` +
          'exists only until the tab is reloaded; give the page a path of its own',
      );
    }
  }
  return problems;
}
