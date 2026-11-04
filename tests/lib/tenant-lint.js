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
 *
 * The first pass reads the SQL *text*, which by construction cannot see a
 * condition assembled at runtime. A second pass closes that gap for the one
 * case the text check deliberately accepts: a statement carrying the
 * `-- tenant` marker promises a builder emits the tenant condition, so the
 * builder is now audited too — the tenant fragment has to be the one the
 * conditions are joined onto (pushed first, or unshifted), and no other
 * fragment may carry a bare `OR` that would escape it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maskSource, skipQuoted } from './source-scan.js';

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
 * Every `receiver.push(<literal>)` / `receiver.unshift(<literal>)` in a file,
 * grouped by the array's name.
 *
 * These are the fragments a WHERE clause is composed from. The order and the
 * shape of the fragments are what decide whether the composed condition can
 * be widened later, so they are collected rather than inferred.
 *
 * @param {string} source the unmasked file contents
 * @param {string} masked the masked copy (same offsets)
 * @returns {Map<string, Array<{kind: string, text: string, line: number, isLiteral: boolean}>>}
 */
function collectClauseBuilders(source, masked) {
  const groups = new Map();
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\.\s*(push|unshift)\s*\(/g;
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    const receiver = match[1];
    const kind = match[2];
    const openIndex = masked.indexOf('(', match.index + match[0].length - 1);
    if (openIndex === -1) continue;
    const argument = readSqlArgument(source, openIndex + 1);
    if (argument === null) continue;
    let cursor = openIndex + 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    const quote = source[cursor];
    const isLiteral =
      (quote === "'" || quote === '"' || quote === '`') &&
      isSelfContained(source, cursor, argument);
    if (!groups.has(receiver)) groups.set(receiver, []);
    groups.get(receiver).push({
      kind,
      text: argument.text.trim(),
      line: lineOf(source, match.index),
      isLiteral,
    });
  }
  return groups;
}

/**
 * Is the argument one self-contained string literal?
 *
 * A fragment is audited by reading its text. Two shapes carry a value the
 * lint cannot see and are therefore *not* literals for this purpose: a
 * template with a `${...}` hole, and a literal concatenated with something
 * else (`'a = ?' + extra`). In both, part of the condition exists only at
 * runtime.
 *
 * @param {string} source
 * @param {number} start index of the opening quote
 * @param {{end: number}} argument the span `readSqlArgument` stopped at
 * @returns {boolean}
 */
function isSelfContained(source, start, argument) {
  const quote = source[start];
  const literalEnd = skipQuoted(source, start);
  if (literalEnd > argument.end) return false;
  if (source.slice(literalEnd, argument.end).trim() !== '') return false;
  if (quote !== '`') return true;
  return !source.slice(start + 1, literalEnd - 1).includes('${');
}

/**
 * Drop every parenthesised span, keeping the rest.
 *
 * `(a LIKE ? OR b LIKE ?)` is a closed group and cannot widen anything, while
 * `a LIKE ? OR b` binds against whatever is joined next to it. Only the
 * second shape is a problem, and this is what tells them apart without a SQL
 * parser.
 *
 * @param {string} text
 * @returns {string}
 */
function stripParenthesised(text) {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Does this fragment carry an OR that is not inside its own parentheses?
 *
 * @param {string} fragment
 * @returns {boolean}
 */
function hasTopLevelOr(fragment) {
  return /\bOR\b/i.test(stripParenthesised(fragment));
}

/**
 * Audit the clause builders of one file.
 *
 * A builder is an array of condition fragments joined with `AND` into the
 * WHERE clause. The text lint reads the *statement*, and the statement cannot
 * show the fragments: a fragment pushed into a `WHERE ${where.join(' AND ')}`
 * template is invisible to it. So the builder is where the tenant condition
 * has to be checked, and these are the ways it can be lost after the text
 * lint has passed:
 *
 *   - the tenant fragment is the first one, or it is `unshift`ed, so every
 *     other fragment is joined *after* it;
 *   - no fragment carries a top-level `OR` that would escape that join;
 *   - no fragment is an expression this lint cannot read — a runtime value
 *     could be a condition too, and an unreadable fragment is an unaudited
 *     one.
 *
 * A fragment near `// tenant-lint: allow <reason>` is skipped, for the same
 * reason the statement check skips such a call: the marker is the file saying
 * "this condition is unscoped on purpose", and the reason makes it reviewable.
 *
 * @param {string} relative the repo-relative path, for the report
 * @param {string} source the file, for the allow-marker escape hatch
 * @param {Map<string, Array<object>>} groups
 * @returns {{problems: string[], hasTenantBuilder: boolean}}
 */
function auditClauseBuilders(relative, source, groups) {
  const problems = [];
  let hasTenantBuilder = false;

  for (const [name, fragments] of groups) {
    const tenants = fragments.filter((fragment) => /\btenant_id\b/i.test(fragment.text));
    if (tenants.length === 0) continue;
    hasTenantBuilder = true;

    for (const fragment of fragments) {
      if (hasAllowMarker(source, fragment.line)) continue;
      if (!fragment.isLiteral) {
        problems.push(
          `${relative}:${fragment.line} — the "${name}" clause pushes an expression this ` +
            'lint cannot read; push a string literal so the tenant condition stays auditable',
        );
        continue;
      }
      if (hasTopLevelOr(fragment.text)) {
        problems.push(
          `${relative}:${fragment.line} — the "${name}" fragment "${fragment.text}" carries a ` +
            'top-level OR; the conditions are joined with AND, so that OR escapes the tenant ' +
            "slice — wrap it in its own parentheses",
        );
      }
    }

    const anchored =
      tenants.some((fragment) => fragment.kind === 'unshift') ||
      /\btenant_id\b/i.test(fragments[0].text);
    if (!anchored) {
      problems.push(
        `${relative}:${tenants[0].line} — the tenant condition on the "${name}" clause is not ` +
          'the first one; push or unshift it before every filter so a later OR cannot widen it',
      );
    }
  }

  return { problems, hasTenantBuilder };
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
    const markerLines = [];
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
      // It is trusted only as far as the builder below can be audited.
      if (/--\s*tenant\b/.test(argument.text)) {
        markerLines.push(lineOf(source, match.index));
        continue;
      }
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

    // The text check above can read a statement that names the tenant. It
    // cannot read one whose condition is composed at runtime — so every
    // clause builder in the file is audited, and a file that hands its
    // condition over via the `-- tenant` marker is additionally required to
    // have one.
    const groups = collectClauseBuilders(source, masked);
    const { problems, hasTenantBuilder } = auditClauseBuilders(relative, source, groups);
    if (markerLines.length > 0 && !hasTenantBuilder) {
      problems.unshift(
        `${relative}:${markerLines[0]} — the query carries the "-- tenant" marker but this file ` +
          'composes no tenant condition; the marker cannot stand in for one',
      );
    }
    violations.push(...problems);
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
