/**
 * Backend route table extraction.
 *
 * The backend used to register every route directly on `app` in
 * `backend/src/server.js`. It has since been split into router factories
 * under `backend/src/routes/`, so a scanner that only looks for
 * `app.get(...)` finds **nothing** and the front↔back contract guard
 * silently degrades into a no-op.
 *
 * This module reconstructs the real route table:
 *
 *   1. `server.js` declares `const createXxxRouter = require('./routes/xxx')`
 *      — that maps a local factory name to a route file.
 *   2. `server.js` mounts those factories with `app.use('<prefix>', factory)`
 *      — that maps a factory to the namespace its routes live in.
 *   3. Each route file registers `router.<verb>('<path>')` — that is the
 *      route itself.
 *
 * From those three facts the module derives the full table, checks that the
 * wiring is consistent in both directions, and checks that no route is
 * shadowed by an earlier one (Express matches in registration order, so
 * `/assets/:id` registered before `/assets/upload` would make `/assets/upload`
 * unreachable).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  maskSource,
  readBalancedRange,
  findCallOpenParen,
  readLiteralAt,
  normalizePath,
  splitTopLevelArgs,
  collectIdentifiers,
} from './source-scan.js';

/** The namespace the frontend's axios instance points at. */
export const ADMIN_NAMESPACE = '/api/v1';

/** The namespace the delivery API lives in. */
export const PUBLIC_NAMESPACE = '/api/public/v1';

/**
 * The token substituted for a path parameter when probing whether an
 * earlier route would swallow a later one. It must not contain a slash.
 */
const SHADOW_PLACEHOLDER = 'x-contract-placeholder';

/** The route verbs the backend uses. */
const ROUTE_VERBS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Join a mount prefix and a route path into the path the server answers.
 *
 * @param {string} prefix
 * @param {string} routePath
 * @returns {string}
 */
function joinPath(prefix, routePath) {
  const left = prefix.replace(/\/+$/, '');
  const right = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${left}${right}` || '/';
}

/**
 * Escape a path segment for use inside a regular expression.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Would a request for `concretePath` be answered by the route registered at
 * `pattern`?
 *
 * @param {string} pattern the normalised route pattern (`:p` = parameter)
 * @param {string} concretePath the path a client would actually request
 * @returns {boolean}
 */
export function pathMatches(pattern, concretePath) {
  const source = pattern
    .split('/')
    .map((segment) => (segment === ':p' ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${source}$`).test(concretePath);
}

/**
 * Map every local factory name to the route file it was required from.
 *
 * @param {string} masked the masked `server.js`
 * @param {string} original the untouched `server.js`
 * @returns {Map<string, string>} factory name → route file (no extension)
 */
function parseRouterFactories(masked, original) {
  const factories = new Map();
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"`])/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const quoteIndex = match.index + match[0].length - 1;
    const literal = readLiteralAt(original, quoteIndex);
    if (literal === null) continue;
    if (!literal.raw.startsWith('./routes/')) continue;
    const file = literal.raw.slice('./routes/'.length).replace(/\.js$/, '');
    factories.set(match[1], file);
  }
  return factories;
}

/**
 * Find every `app.use(...)` that mounts a router factory.
 *
 * Mounts that carry no factory (CORS, the JSON body parser, the static file
 * handler, the 404 catch-all) are not routers and are skipped.
 *
 * @param {string} masked
 * @param {string} original
 * @param {Map<string, string>} factories
 * @returns {Array<{prefix: string|null, factories: string[], line: number}>}
 */
function parseRouterMounts(masked, original, factories) {
  const mounts = [];
  const re = /\bapp\s*\.\s*use\s*\(/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const parenIndex = findCallOpenParen(masked, match.index + match[0].length - 1);
    if (parenIndex === null) continue;
    const range = readBalancedRange(masked, parenIndex);
    if (range === null) continue;
    const argsMasked = masked.slice(range.start, range.end);
    const args = splitTopLevelArgs(argsMasked);

    const usedFactories = [];
    for (const arg of args) {
      for (const identifier of collectIdentifiers(arg.text)) {
        if (factories.has(identifier) && !usedFactories.includes(identifier)) {
          usedFactories.push(identifier);
        }
      }
    }
    if (usedFactories.length === 0) continue;

    const first = args[0].text;
    const lead = first.length - first.trimStart().length;
    const prefixLiteral = readLiteralAt(original, range.start + lead);

    mounts.push({
      prefix: prefixLiteral === null ? null : prefixLiteral.raw.replace(/\/+$/, ''),
      factories: usedFactories,
      line: original.slice(0, match.index).split('\n').length,
    });
  }
  return mounts;
}

/**
 * Extract the routes a single router file registers.
 *
 * @param {string} filePath
 * @returns {Array<{method: string, path: string, rawPath: string, line: number}>}
 */
export function parseRouterRoutes(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const masked = maskSource(source);
  const routes = [];
  const re = new RegExp(`\\brouter\\s*\\.\\s*(${ROUTE_VERBS.join('|')})\\s*\\(\\s*(['"\`])`, 'g');
  let match;
  while ((match = re.exec(masked)) !== null) {
    const quoteIndex = match.index + match[0].length - 1;
    const literal = readLiteralAt(source, quoteIndex);
    if (literal === null) continue;
    routes.push({
      method: match[1].toUpperCase(),
      path: normalizePath(literal.raw, literal.isTemplate),
      rawPath: literal.raw,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return routes;
}

/**
 * Extract the routes registered directly on `app` in `server.js`.
 *
 * Only `/api/...` paths count — the SPA fallback (`app.get('/')` and the
 * catch-all regex) is not part of the API surface.
 *
 * @param {string} source
 * @param {string} masked
 * @param {string} fileLabel the file the routes belong to
 * @returns {Array<{method: string, path: string, rawPath: string, line: number}>}
 */
function parseDirectAppRoutes(source, masked, fileLabel) {
  const routes = [];
  const re = new RegExp(`\\bapp\\s*\\.\\s*(${ROUTE_VERBS.join('|')})\\s*\\(\\s*(['"\`])`, 'g');
  let match;
  while ((match = re.exec(masked)) !== null) {
    const quoteIndex = match.index + match[0].length - 1;
    const literal = readLiteralAt(source, quoteIndex);
    if (literal === null) continue;
    if (!literal.raw.startsWith('/api')) continue;
    routes.push({
      method: match[1].toUpperCase(),
      path: normalizePath(literal.raw, literal.isTemplate),
      rawPath: literal.raw,
      line: source.slice(0, match.index).split('\n').length,
      file: fileLabel,
    });
  }
  return routes;
}

/**
 * Build the full backend route table.
 *
 * @param {{serverFile: string, routesDir: string, repoRoot: string}} input
 * @returns {{
 *   routes: Array<{method: string, path: string, rawPath: string, namespace: string,
 *                  fullPath: string, file: string, line: number}>,
 *   problems: string[],
 *   mounts: Array<{prefix: string|null, factories: string[], line: number}>,
 *   routeFiles: string[]
 * }}
 */
export function parseBackendRoutes({ serverFile, routesDir, repoRoot }) {
  const problems = [];
  const serverSource = fs.readFileSync(serverFile, 'utf8');
  const serverMasked = maskSource(serverSource);
  const serverLabel = path.relative(repoRoot, serverFile).replace(/\\/g, '/');

  const factories = parseRouterFactories(serverMasked, serverSource);
  const mounts = parseRouterMounts(serverMasked, serverSource, factories);

  const routeFiles = fs
    .readdirSync(routesDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.replace(/\.js$/, ''));

  const mountedFiles = new Set();
  const routes = [];

  // --- Routes registered directly on `app` (the health probes) -------------
  for (const route of parseDirectAppRoutes(serverSource, serverMasked, serverLabel)) {
    routes.push({
      ...route,
      namespace: '',
      fullPath: route.path,
    });
  }

  // --- Routes registered by the mounted routers ---------------------------
  for (const mount of mounts) {
    if (mount.prefix === null) {
      problems.push(
        `${serverLabel}:${mount.line} mounts a router without a path prefix — ` +
          'every router must live under an /api namespace',
      );
      continue;
    }
    if (!mount.prefix.startsWith('/api/')) {
      problems.push(
        `${serverLabel}:${mount.line} mounts a router on "${mount.prefix}" — ` +
          'every router must live under an /api namespace',
      );
      continue;
    }
    for (const factoryName of mount.factories) {
      const file = factories.get(factoryName);
      if (file === undefined) {
        problems.push(
          `${serverLabel}:${mount.line} mounts "${factoryName}()" but server.js never requires it from ./routes/`,
        );
        continue;
      }
      const absolute = path.join(routesDir, `${file}.js`);
      if (!fs.existsSync(absolute)) {
        problems.push(
          `${serverLabel}:${mount.line} mounts "${factoryName}()" → ./routes/${file}.js, which does not exist`,
        );
        continue;
      }
      mountedFiles.add(file);
      const fileLabel = path.relative(repoRoot, absolute).replace(/\\/g, '/');
      for (const route of parseRouterRoutes(absolute)) {
        routes.push({
          ...route,
          file: fileLabel,
          namespace: mount.prefix,
          fullPath: joinPath(mount.prefix, route.path),
        });
      }
    }
  }

  // --- Every route file must actually be reachable ------------------------
  for (const file of routeFiles) {
    if (!mountedFiles.has(file)) {
      problems.push(
        `backend/src/routes/${file}.js is never mounted — ` +
          'add it to an app.use() in server.js or delete it',
      );
    }
  }

  return { routes, problems, mounts, routeFiles };
}

/**
 * Find routes that an earlier route would swallow.
 *
 * Express matches in registration order, so a parameterised route registered
 * before a literal one makes the literal one unreachable.
 *
 * @param {Array<{method: string, path: string, namespace: string, fullPath: string, file: string, line: number}>} routes
 * @returns {string[]} human readable problems
 */
export function findShadowingProblems(routes) {
  const problems = [];
  const groups = new Map();
  for (const route of routes) {
    const key = `${route.method} ${route.namespace}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const earlier = group[i];
        const later = group[j];
        const concrete = later.path.replace(/:p/g, SHADOW_PLACEHOLDER);
        if (!pathMatches(earlier.path, concrete)) continue;
        problems.push(
          `${earlier.file}:${earlier.line} registers ${earlier.method} ${earlier.fullPath} ` +
            `before ${later.file}:${later.line} registers ${later.method} ${later.fullPath} — ` +
            'Express answers the later request with the earlier handler',
        );
      }
    }
  }
  return problems;
}

/**
 * Index the routes of one namespace by `METHOD /path`.
 *
 * @param {Array<object>} routes
 * @param {string} namespace
 * @returns {Map<string, object>}
 */
export function buildRouteIndex(routes, namespace = ADMIN_NAMESPACE) {
  const index = new Map();
  for (const route of routes) {
    if (route.namespace !== namespace) continue;
    index.set(`${route.method} ${route.path}`, route);
  }
  return index;
}
