/**
 * Resolution of runtime-built request paths.
 *
 * Three call sites in the frontend build their path at runtime:
 *
 *   const detailPath = id ? `/assets/${id}` : null;      → useApi(detailPath)
 *   const listPath = useMemo(() => buildPath({ … }));   → useApi(listPath)
 *   useApi(buildQuery({ … }))                            → buildQuery returns `/assets?…`
 *
 * A static guard that cannot read those paths cannot tell a correct path
 * from a broken one — and the broken one is exactly what this project has
 * been bitten by: `/api/v1/assets` on top of an axios baseURL of `/api/v1`,
 * which answers 404 for every request the page makes.
 *
 * This module follows the local definition back to the path literal it
 * produces, so those three sites are checked like every other one.
 *
 * The resolution is deliberately conservative. It only follows:
 *
 *   - a path literal written directly in the expression,
 *   - a local `const` / `let` / `var` binding,
 *   - a local `function` declaration, through its `return` statement,
 *   - a call to such a function, one level deep inside the expression.
 *
 * Anything else resolves to `null`, and the call site stays in the
 * "not statically checked" list. A wrong resolution is worse than no
 * resolution, so every step bails out rather than guessing.
 */

import { readBalancedRange, skipQuoted } from './source-scan.js';

/** How many definitions may be chained before the resolver gives up. */
const MAX_DEPTH = 3;

/** Keywords that look like calls but never name a path builder. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'new', 'do', 'else', 'case', 'function', 'require', 'import',
]);

/**
 * Find the first path-like string literal inside a piece of text.
 *
 * "Path-like" means the literal starts with a slash — a query value or a
 * fragment is not a route.
 *
 * @param {string} text
 * @returns {{raw: string, isTemplate: boolean}|null}
 */
function findPathLiteralInText(text) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '`' && ch !== "'" && ch !== '"') continue;
    const stop = skipQuoted(text, i);
    const raw = text.slice(i + 1, stop - 1);
    if (raw.startsWith('/')) return { raw, isTemplate: ch === '`' };
    i = stop - 1;
  }
  return null;
}

/**
 * The end of the expression that starts at `start`.
 *
 * The expression stops at the first top-level `;` or `,` — a top-level `}`
 * or `)` means the caller ran out of text first.
 *
 * @param {string} masked
 * @param {number} start
 * @param {number} limit
 * @returns {number}
 */
function expressionEnd(masked, start, limit) {
  let depth = 0;
  let i = start;
  for (; i < limit; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === ',')) break;
  }
  return i;
}

/**
 * The path literal an expression produces.
 *
 * @param {string} masked
 * @param {string} original
 * @param {number} start
 * @param {number} end
 * @param {number} depth
 * @returns {{raw: string, isTemplate: boolean}|null}
 */
function resolveFromExpression(masked, original, start, end, depth) {
  if (depth > MAX_DEPTH) return null;

  const stop = expressionEnd(masked, start, end);
  const spanText = original.slice(start, stop);

  const direct = findPathLiteralInText(spanText);
  if (direct !== null) return direct;

  // The expression calls something — maybe a local path builder.
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = callRe.exec(spanText)) !== null) {
    const name = match[1];
    if (NOT_A_CALL.has(name)) continue;
    const literal =
      resolveFromBinding(masked, original, name, depth + 1) ??
      resolveFromFunction(masked, original, name, depth + 1);
    if (literal !== null) return literal;
  }
  return null;
}

/**
 * The path literal a local `const` / `let` / `var` binding holds.
 *
 * @param {string} masked
 * @param {string} original
 * @param {string} name
 * @param {number} depth
 * @returns {{raw: string, isTemplate: boolean}|null}
 */
function resolveFromBinding(masked, original, name, depth) {
  if (depth > MAX_DEPTH) return null;
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, 'g');
  const match = re.exec(masked);
  if (match === null) return null;
  const valueStart = match.index + match[0].length;
  return resolveFromExpression(masked, original, valueStart, masked.length, depth + 1);
}

/**
 * The path literal a local function declaration returns.
 *
 * @param {string} masked
 * @param {string} original
 * @param {string} name
 * @param {number} depth
 * @returns {{raw: string, isTemplate: boolean}|null}
 */
function resolveFromFunction(masked, original, name, depth) {
  if (depth > MAX_DEPTH) return null;
  const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
  const match = re.exec(masked);
  if (match === null) return null;

  const parenIndex = masked.indexOf('(', match.index);
  const paramRange = readBalancedRange(masked, parenIndex);
  if (paramRange === null) return null;

  const braceIndex = masked.indexOf('{', paramRange.end);
  if (braceIndex === -1) return null;
  const bodyRange = readBalancedRange(masked, braceIndex);
  if (bodyRange === null) return null;

  const bodyMasked = masked.slice(bodyRange.start, bodyRange.end);
  const bodyOriginal = original.slice(bodyRange.start, bodyRange.end);

  const returnRe = /\breturn\b/g;
  let returnMatch;
  while ((returnMatch = returnRe.exec(bodyMasked)) !== null) {
    const literal = resolveFromExpression(
      bodyMasked,
      bodyOriginal,
      returnMatch.index + returnMatch[0].length,
      bodyMasked.length,
      depth + 1,
    );
    if (literal !== null) return literal;
  }
  return null;
}

/**
 * Resolve the path literal behind a call argument that is not itself a
 * literal.
 *
 * @param {string} masked the masked source of the file
 * @param {string} original the untouched source of the file
 * @param {string|null} argText the argument as source text
 * @returns {{raw: string, isTemplate: boolean}|null} the resolved literal
 */
export function resolvePathArgument(masked, original, argText) {
  if (argText === null) return null;
  const text = argText.trim();
  if (text.length === 0) return null;

  // A literal written inside the expression itself — `id ? '/a' : '/b'`.
  const inline = findPathLiteralInText(text);
  if (inline !== null) return inline;

  // A call to a local path builder — `buildQuery({ … })`.
  const callMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  if (callMatch !== null) {
    const name = callMatch[1];
    if (!NOT_A_CALL.has(name)) {
      return (
        resolveFromBinding(masked, original, name, 0) ??
        resolveFromFunction(masked, original, name, 0)
      );
    }
    return null;
  }

  // A local constant — `detailPath`.
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return (
      resolveFromBinding(masked, original, text, 0) ??
      resolveFromFunction(masked, original, text, 0)
    );
  }

  return null;
}
