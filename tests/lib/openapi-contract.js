/**
 * The OpenAPI specification and the routes it describes.
 *
 * A specification that has drifted from the code is worse than no
 * specification: it is a document that lies with the authority of a machine-
 * readable one. A reader who trusts it will build against endpoints that are
 * not there, and will not find out until the request fails.
 *
 * So the specification is checked against the **route table the code really
 * registers**, in both directions:
 *
 *   - every route the backend serves is described in the specification, and
 *   - every operation in the specification exists in the backend.
 *
 * The first direction keeps the documentation complete; the second keeps it
 * from inventing endpoints. A third rule — every operation carries a summary
 * — keeps the specification from degrading into a bare route table.
 *
 * The route table is not hand-written here: it is derived from the source by
 * `tests/lib/backend-routes.js`, exactly as the API contract guard does. If
 * the backend changes, this check changes with it.
 */

import fs from 'node:fs';
import * as yaml from 'js-yaml';

/** The verbs a path item may carry. */
const OPERATIONS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Reduce a path to a shape that can be compared.
 *
 * The backend names its parameters `:id`; the specification names them
 * `{id}`. Both are "a segment that holds whatever is put there", so both
 * become `:p`. A wildcard segment (`/storage/*`) covers the rest of the path
 * and is reduced the same way.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeSpecPath(value) {
  return (
    String(value)
      .replace(/\{[^}]+\}/g, ':p')
      .split('/')
      .map((segment) => (segment === '*' ? ':p' : segment))
      .join('/')
      .replace(/\/+$/, '') || '/'
  );
}

/**
 * The operations a specification describes.
 *
 * @param {object} spec the parsed specification
 * @returns {Array<{method: string, path: string, summary: string, tags: string[]}>}
 */
export function specOperations(spec) {
  const operations = [];
  const paths = (spec && spec.paths) || {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const verb of OPERATIONS) {
      const operation = item[verb];
      if (!operation || typeof operation !== 'object') continue;
      operations.push({
        method: verb.toUpperCase(),
        path,
        summary: typeof operation.summary === 'string' ? operation.summary.trim() : '',
        tags: Array.isArray(operation.tags) ? operation.tags : [],
      });
    }
  }
  return operations;
}

/**
 * Read the specification from disk.
 *
 * @param {string} specFile
 * @returns {object} the parsed specification
 */
export function readSpec(specFile) {
  return yaml.load(fs.readFileSync(specFile, 'utf8'));
}

/**
 * The problems a specification has, measured against the routes the backend
 * really serves.
 *
 * @param {{spec: object, backendRoutes: Array<{method: string, fullPath: string}>}} input
 * @returns {string[]} one line per problem, empty when the two agree
 */
export function findSpecProblems({ spec, backendRoutes }) {
  const problems = [];

  if (!spec || typeof spec !== 'object') {
    return ['the specification could not be read'];
  }
  if (!spec.openapi) {
    problems.push('the specification has no `openapi` version');
  }
  if (!spec.info || !spec.info.title || !spec.info.version) {
    problems.push('the specification has no `info.title` / `info.version`');
  }

  const operations = specOperations(spec);
  if (operations.length === 0) {
    problems.push('the specification describes no operations at all');
  }

  const specKeys = new Set(operations.map((op) => `${op.method} ${normalizeSpecPath(op.path)}`));
  const backendKeys = new Set(
    backendRoutes.map((route) => `${route.method} ${normalizeSpecPath(route.fullPath)}`),
  );

  for (const key of backendKeys) {
    if (!specKeys.has(key)) {
      problems.push(
        `${key} — the backend serves it, but the specification does not describe it`,
      );
    }
  }
  for (const key of specKeys) {
    if (!backendKeys.has(key)) {
      problems.push(
        `${key} — the specification describes it, but the backend serves nothing there`,
      );
    }
  }

  for (const operation of operations) {
    if (operation.summary === '') {
      problems.push(`${operation.method} ${operation.path} — the operation has no summary`);
    }
    if (operation.tags.length === 0) {
      problems.push(`${operation.method} ${operation.path} — the operation has no tag`);
    }
  }

  return problems;
}
