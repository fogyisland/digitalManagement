/**
 * Tenant-scope lint.
 *
 * The tenant filter is the only thing standing between two tenants' data, so
 * a query that forgets it is a leak. The spec's chosen mechanism is a
 * *static* check rather than a SQL-rewriting proxy: every business statement
 * has to mention `tenant_id`, and this guard fails the build when one does
 * not.
 *
 * It reads what the server actually runs, in `src/server/routes` and
 * `src/server/lib` — the two directories the spec names:
 *
 *   - `db.prepare(<sql>)` — the shape every business query uses;
 *   - `db.query(<sql>)` — the text-protocol escape hatch (schema metadata
 *     only; `information_schema` is not a business table, so it passes).
 *
 * The SQL argument may be a plain literal, a template literal, or a
 * concatenation (`'…' + whereSql`). For the composed forms the *literal
 * parts* are what get checked, which is exactly right: a condition that only
 * exists at runtime cannot be audited.
 *
 * Two ways to satisfy the check, both of them visible in the report:
 *
 *   1. the SQL mentions `tenant_id` — the ordinary case;
 *   2. the query carries a marker the reviewer can read:
 *        - `-- tenant` inside the SQL, for a statement whose condition is
 *          composed from a builder that always emits it (spec §2.3 names
 *          this marker);
 *        - `// tenant-lint: allow <reason>` on the call's line, for a query
 *          that is unscoped *by design* (the platform administrator's
 *          wildcard read). The reason is required.
 *
 * Tables that are deliberately cross-tenant are listed as exemptions with
 * the reason they are exempt — an exemption nobody can read is a hole.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maskSource } from './source-scan.js';

/**
 * The tables whose rows belong to one tenant.
 *
 * Kept in sync with `TENANT_SCOPED_TABLES` by hand: the two lists answer
 * different questions (this one is "what must every query filter by", that
 * one is "what needs the column"), and a table can be in the second without
 * being in the first only if it is listed as an exemption below.
 */
export const BUSINESS_TABLES = [
  'assets',
  'users',
  'api_keys',
  'categories',
  'tags',
  'webhook_endpoints',
  'upload_sessions',
  'audit_logs',
  'asset_tags',
  'manifest_writes',
];

/**
 * Queries that touch a business table on purpose without a tenant filter.
 *
 * Each entry is `{ file, table, reason }`. The file is matched by suffix so
 * the list survives a directory reorganisation; the reason is what makes the
 * exemption reviewable.
 */
export const EXEMPTIONS = [
  {
    file: 'src/server/lib/manifest.js',
    table: 'assets',
    reason:
      'the storage manifest is the whole library\'s index, not a tenant API — ' +
      'every entry carries its `tenant_id` so a consumer can filter',
  },
  {
    file: 'src/server/lib/manifest.js',
    table: 'manifest_writes',
    reason:
      'the replay drains every live tenant\'s pending writes because the index ' +
      'it rebuilds is cross-tenant; the row\'s `tenant_id` is selected, not filtered',
  },
];

/**
 * The files the lint covers: `routes/` and `lib/`, as the spec names them.
 *
 * `scripts/` is deliberately outside: it holds the operator's maintenance
 * commands (`npm run seed:force`), which act on the whole library by design.
 *
 * @param {string} serverDir `src/server`
 * @returns {string[]}
 */
function collectSourceDirs(serverDir) {
  return [
    ...collectJsFiles(path.join(serverDir, 'routes')),
    ...collectJsFiles(path.join(serverDir, 'lib')),
  ];
}

/**
 * Every `.js` file under a directory, recursively.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectJsFiles(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectJsFiles(full));
    } else if (/\.js$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The line a character offset sits on, 1-based.
 *
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Read the SQL argument of a `db.prepare(...)` / `db.query(...)` call.
 *
 * Returns the *literal text* of the argument: quotes are stripped, and for a
 * concatenation the pieces are joined. Interpolated expressions keep their
 * `${...}` / `" + ... + "` form so the caller can tell literal text from a
 * runtime value.
 *
 * @param {string} original the unmasked file contents
 * @param {number} from the index just past the call's opening parenthesis
 * @returns {{text: string, end: number}|null}
 */
function readSqlArgument(original, from) {
  let depth = 0;
  let quote = null;
  let backtick = false;
  let out = '';
  for (let i = from; i < original.length; i += 1) {
    const ch = original[i];
    if (quote) {
      if (ch === '\\') {
        out += ch + (original[i + 1] || '');
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ' ';
        continue;
      }
      if (backtick && ch === '$' && original[i + 1] === '{') {
        const close = original.indexOf('}', i);
        const stop = close === -1 ? original.length : close + 1;
        out += original.slice(i, stop);
        i = stop - 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      backtick = ch === '`';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return { text: out, end: i };
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return { text: out, end: i };
    }
    if (!quote) out += ch;
  }
  return null;
}

/**
 * Which business tables does this SQL text touch?
 *
 * Word-boundary matched against the table names, so `asset_tags` is not
 * mistaken for `assets` and a column called `tag_count` is not a table.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tablesIn(text) {
  const found = [];
  for (const table of BUSINESS_TABLES) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${table}([^A-Za-z0-9_]|$)`, 'i');
    if (pattern.test(text)) found.push(table);
  }
  return found;
}

/**
 * Find the business queries that do not mention the tenant.
 *
 * @param {{srcDir: string, repoRoot: string}} input `srcDir` is the server
 *   source root (`src/server`); `repoRoot` is used to print repo-relative
 *   paths
 * @returns {string[]} one `file:line — message` per violation
 */
export function findUnscopedQueries({ srcDir, repoRoot }) {
  const violations = [];

  for (const file of collectSourceDirs(srcDir)) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    const masked = maskSource(source);
    const callPattern = /\bdb\s*\.\s*(prepare|query)\s*\(/g;
    let match;
    while ((match = callPattern.exec(masked)) !== null) {
      const openIndex = masked.indexOf('(', match.index + match[0].length - 1);
      if (openIndex === -1) continue;
      const argument = readSqlArgument(source, openIndex + 1);
      if (argument === null) continue;
      const tables = tablesIn(argument.text);
      if (tables.length === 0) continue;
      if (/\btenant_id\b/i.test(argument.text)) continue;
      // The marker the spec names for a condition composed from a builder.
      if (/--\s*tenant\b/.test(argument.text)) continue;
      // An unscoped query that is unscoped on purpose, with its reason.
      const callLine = lineOf(source, match.index);
      if (hasAllowMarker(source, callLine)) continue;

      const exempt = tables.every((table) =>
        EXEMPTIONS.some(
          (entry) => relative.endsWith(entry.file) && entry.table === table,
        ),
      );
      if (exempt) continue;

      violations.push(
        `${relative}:${callLine} — a query on ${tables.join(', ')} has no tenant condition`,
      );
    }
  }

  return violations;
}

/**
 * Does the line carry an explicit "this one is unscoped on purpose" marker?
 *
 * The marker has to name a reason: `// tenant-lint: allow <reason>`. A bare
 * marker is not enough — the point is that a reviewer can read why.
 *
 * @param {string} source
 * @param {number} line the 1-based line of the call
 * @returns {boolean}
 */
function hasAllowMarker(source, line) {
  const lines = source.split('\n');
  const start = Math.max(0, line - 3);
  const end = Math.min(lines.length, line + 1);
  return lines
    .slice(start, end)
    .some((text) => /\/\/\s*tenant-lint:\s*allow\s+\S/.test(text));
}

/**
 * Describe the exemptions, for the report the guard prints.
 *
 * @returns {string[]}
 */
export function describeExemptions() {
  return EXEMPTIONS.map((entry) => `${entry.file} (${entry.table}) — ${entry.reason}`);
}
