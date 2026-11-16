/**
 * The links the interface offers, and whether they lead anywhere.
 *
 * A link in the interface is a promise: "click here and you will get there".
 * The SPA's catch-all route makes that promise hard to keep — the server
 * answers *every* unknown path with the application's own `index.html`, so a
 * link to a page that does not exist comes back with HTTP 200 and an
 * application that says "not found". The user gets a dead end dressed up as
 * a working link.
 *
 * That is not hypothetical. The tenant settings page advertised `/docs` as
 * "Swagger UI" and `/redoc` as "ReDoc" for a long time, and neither address
 * was ever served by anything but the SPA shell — the repository had never
 * contained a swagger or redoc dependency at all.
 *
 * This rule reads the links the frontend offers and asks the one question
 * that matters: does the target exist?
 *
 *   - a page of the SPA (`src/client/router.tsx`),
 *   - a route the server serves (`src/server`),
 *   - a path under a mounted router — the server owns that whole subtree,
 *   - a real file under `public/` or the built `dist/`.
 *
 * A link that names none of them is a dead end, and it fails the build.
 *
 * Three shapes of link are read, because the interface uses all three:
 *
 *   - `href="/path"` — a plain anchor,
 *   - `to="/path"` — a react-router `<Link>` / `<Navigate>`,
 *   - `navigate("/path")` — the imperative navigation.
 *
 * A link whose target is built at runtime cannot be checked statically. Those
 * are counted and listed, so the summary never claims more coverage than it
 * has — the same accounting the API call-site check keeps.
 */

import fs from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, maskSource, normalizePath, readLiteralAt } from './source-scan.js';

/**
 * The attributes and calls that carry a link.
 *
 * `href` may point anywhere (a file, a route); `to` and `navigate` are the
 * router's own — they are client-side navigations and have to name a page.
 *
 * The `{` is the JSX expression container: `href={`/library/${id}`}` holds a
 * template literal, and without it the scan would miss every link written
 * that way.
 */
const LINK_SHAPES = [
  { kind: 'href', pattern: /\bhref\s*=\s*\{?\s*(['"`])/g },
  { kind: 'spa', pattern: /\bto\s*=\s*\{?\s*(['"`])/g },
  { kind: 'spa', pattern: /\bnavigate\s*\(\s*(['"`])/g },
];

/**
 * The fewest links the scan has to find for the rule to be worth running.
 *
 * A rule that quietly stops finding anything looks exactly like a rule that
 * passes, so a scan that comes up nearly empty is itself a failure.
 */
export const MINIMUM_LINKS = 5;

/**
 * Find the internal links the frontend offers.
 *
 * @param {{srcDir: string}} input
 * @returns {{links: Array<{file: string, line: number, kind: string, raw: string, path: string}>,
 *            skipped: Array<{file: string, line: number, reason: string}>}}
 */
export function parseInternalLinks({ srcDir }) {
  const links = [];
  const skipped = [];

  for (const file of collectSourceFiles(srcDir)) {
    const source = fs.readFileSync(file, 'utf8');
    const masked = maskSource(source);

    for (const shape of LINK_SHAPES) {
      const re = new RegExp(shape.pattern.source, 'g');
      let match;
      while ((match = re.exec(masked)) !== null) {
        const quoteIndex = match.index + match[0].length - 1;
        const literal = readLiteralAt(source, quoteIndex);
        const where = `${path.relative(srcDir, file)}:${source.slice(0, match.index).split('\n').length}`;

        if (literal === null) {
          skipped.push({ file: where, reason: 'the target is not a literal' });
          continue;
        }
        const raw = literal.raw.trim();
        // A relative target is resolved against the page it is on, which the
        // static check cannot know. An external one is somebody else's page.
        if (!raw.startsWith('/')) {
          skipped.push({
            file: where,
            reason: raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)
              ? 'the target is not internal'
              : 'the target is relative',
          });
          continue;
        }
        links.push({
          file: where,
          line: source.slice(0, match.index).split('\n').length,
          kind: shape.kind,
          raw,
          path: normalizePath(raw, literal.isTemplate),
        });
      }
    }
  }

  return { links, skipped };
}

/**
 * Do two path patterns describe the same shape of path?
 *
 * A segment that is a parameter on either side matches whatever the other
 * side holds, so `/library/:p` and `/library/:id` are the same route.
 *
 * @param {string} routePattern
 * @param {string} linkPattern
 * @returns {boolean}
 */
export function patternsMatch(routePattern, linkPattern) {
  const routeSegments = routePattern.split('/').filter(Boolean);
  const linkSegments = linkPattern.split('/').filter(Boolean);
  if (routeSegments.length !== linkSegments.length) return false;
  return routeSegments.every((segment, index) => {
    const other = linkSegments[index];
    if (segment.startsWith(':') || other.startsWith(':')) return true;
    return segment === other;
  });
}

/**
 * Is the path under a prefix the server owns?
 *
 * A mount claims the prefix and everything below it: `app.use('/storage')`
 * answers `/storage` and `/storage/anything`, but not `/storagex`.
 *
 * @param {string} linkPattern
 * @param {string[]} prefixes
 * @returns {boolean}
 */
export function underMount(linkPattern, prefixes) {
  return prefixes.some((prefix) => {
    if (!prefix) return false;
    if (linkPattern === prefix) return true;
    return linkPattern.startsWith(`${prefix}/`);
  });
}

/**
 * Is the path a real file the instance serves?
 *
 * @param {string} linkPattern
 * @param {string[]} roots
 * @returns {boolean}
 */
export function isStaticFile(linkPattern, roots) {
  if (linkPattern.includes(':p')) return false;
  const relative = linkPattern.replace(/^\/+/, '');
  if (relative === '') return false;
  return roots.some((root) => {
    const target = path.join(root, relative);
    return fs.existsSync(target) && fs.statSync(target).isFile();
  });
}

/**
 * The links that lead nowhere.
 *
 * @param {{links: Array<{file: string, line: number, kind: string, raw: string, path: string}>,
 *          spaRoutes: Array<{path: string}>,
 *          backendRoutes: Array<{path: string}>,
 *          mounts: Array<{prefix: string|null}>,
 *          staticRoots?: string[]}} input
 * @returns {string[]} one line per dead link, empty when they all lead somewhere
 */
export function findDeadLinkProblems({
  links,
  spaRoutes,
  backendRoutes,
  mounts,
  staticRoots = [],
}) {
  const problems = [];
  const prefixes = mounts.map((mount) => mount.prefix).filter(Boolean);
  const spaPaths = spaRoutes.map((route) => route.path);
  const serverPaths = backendRoutes.map((route) => route.path);

  for (const link of links) {
    const known =
      spaPaths.some((route) => patternsMatch(route, link.path)) ||
      serverPaths.some((route) => patternsMatch(route, link.path)) ||
      underMount(link.path, prefixes) ||
      isStaticFile(link.path, staticRoots);
    if (known) continue;

    problems.push(
      `${link.file} — the link "${link.raw}" leads nowhere: it is not a page of the ` +
        'SPA, not a route of the server, not under a mounted router and not a file ' +
        'under public/ or dist/. The SPA answers it with its own "not found" page, ' +
        'so the link is a dead end dressed up as a working one',
    );
  }

  return problems;
}
