/**
 * Low-level source scanning helpers for the front↔back contract guard.
 *
 * The guard reads two kinds of files: TypeScript/TSX call sites on the
 * frontend and plain JavaScript route registrations on the backend. Both are
 * scanned on a *masked* copy of the source — comment bodies and string bodies
 * are blanked out while the original length and the string delimiters are
 * kept.
 *
 * That way a path mentioned in a comment can never be mistaken for a call
 * site, while the literal contents can still be read back from the original
 * file. Offsets align between the two copies because the mask preserves the
 * length exactly.
 *
 * Everything here is pure: the only file system access is
 * `collectSourceFiles`, which walks a directory tree.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The keywords after which a `/` starts a regular expression rather than a
 * division.
 *
 * `return /x/` is a regular expression; `a / b` is a division. The two look
 * the same to a scanner that only sees the slash, and reading the wrong one
 * means skipping the wrong span of the file.
 */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Can a regular expression start at this `/`?
 *
 * The answer is decided by what comes before it: after an identifier, a
 * number, a closing bracket or a closing parenthesis, a slash divides. After
 * an operator, an opening bracket, a comma or a keyword that expects a value,
 * it starts a regular expression.
 *
 * @param {string} source
 * @param {number} index the index of the `/`
 * @returns {boolean}
 */
function regexCanStartAt(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;
  const ch = source[i];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    // An identifier: a regular expression only follows one of the keywords
    // that expect a value. `return` is one, `total` is not.
    let start = i;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(source[start])) start -= 1;
    const word = source.slice(start + 1, i + 1);
    return REGEX_AFTER_KEYWORD.has(word);
  }
  // `)` and `]` and `}` end a value, so a slash after them divides.
  return !')]}'.includes(ch);
}

/**
 * Return the index just past the regular expression that starts at `start`.
 *
 * The body may hold escapes and character classes, and the closing slash may
 * not be the one that looks like it closes — `/[/]/` is one literal, not two.
 *
 * @param {string} source
 * @param {number} start index of the opening `/`
 * @returns {number} index just past the literal, or -1 when there is none
 */
export function skipRegex(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    // A regular expression cannot span lines — if it did, the slash was a
    // division after all.
    if (ch === '\n') return -1;
    if (inClass) {
      if (ch === ']') inClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      // The flags.
      while (i < source.length && /[a-z]/.test(source[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Replace every comment body, every string body and every regular expression
 * body with spaces.
 *
 * Newlines inside a masked region are preserved so line numbers computed on
 * the masked copy still match the original file.
 *
 * @param {string} source
 * @returns {string} the masked source, exactly as long as the input
 */
export function maskSource(source) {
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
      // A block comment has to close. `/*` that never closes is not a comment
      // at all: in JSX text — `<span>/api/v1/*</span>` — the sequence is
      // ordinary text, and reading it as a comment swallows the rest of the
      // file. That is not a cosmetic problem: everything after it stops being
      // scanned, so the checks quietly report less than they looked at.
      const close = source.indexOf('*/', i + 2);
      if (close === -1) {
        out += '/*';
        i += 2;
        continue;
      }
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
    if (ch === '/' && regexCanStartAt(source, i)) {
      // A regular expression is masked like a string, and for the same
      // reason: its body may hold a quote (`/["\\]/`), and a quote the
      // scanner reads as the start of a string makes it swallow the rest of
      // the file. Every route registered after such a literal stopped being
      // seen — the checks reported less than they looked at, which is worse
      // than reporting nothing.
      const end = skipRegex(source, i);
      if (end !== -1) {
        out += '/';
        for (let k = i + 1; k < end - 1; k += 1) out += source[k] === '\n' ? '\n' : ' ';
        out += source[end - 1];
        i = end;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipQuoted(source, i);
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
 *
 * Handles `'`, `"` and backtick templates — including the `${}` holes, whose
 * content is skipped without being interpreted.
 *
 * @param {string} source
 * @param {number} start index of the opening delimiter
 * @returns {number} index just past the closing delimiter
 */
export function skipQuoted(source, start) {
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
 *
 * @param {string} source
 * @param {number} openIndex index of the opening bracket
 * @returns {{start: number, end: number}|null} the half-open span of the
 *   inner content, or `null` when the bracket is never closed
 */
export function readBalancedRange(source, openIndex) {
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
 *
 * @param {string} source
 * @param {number} start index of the opening `<`
 * @returns {number|null} index just past the closing `>`
 */
export function findGenericEnd(source, start) {
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
 * optional generic argument list.
 *
 * @param {string} source
 * @param {number} from index to start scanning at
 * @returns {number|null} index of the `(`, or `null` when there is no call
 */
export function findCallOpenParen(source, from) {
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
 * Read the first argument of a call.
 *
 * Returns `null` when the argument is not a plain string literal (a
 * variable, a function call, …) — those call sites cannot be checked
 * statically and are reported as skipped instead of silently passing.
 *
 * @param {string} original the untouched source
 * @param {string} masked the masked source (same offsets)
 * @param {number} argsStart index of the opening `(`
 * @returns {{raw: string, isTemplate: boolean}|null}
 */
export function readFirstArgument(original, masked, argsStart) {
  const range = readBalancedRange(masked, argsStart);
  if (range === null) return null;
  const maskedArgs = masked.slice(range.start, range.end);
  const trimmed = maskedArgs.trim();
  if (trimmed.length === 0) return null;
  const offset = maskedArgs.indexOf(trimmed[0]);
  const valueStart = range.start + offset;
  return readLiteralAt(original, valueStart);
}

/**
 * Read a string literal that starts at `index`.
 *
 * @param {string} original
 * @param {number} index
 * @returns {{raw: string, isTemplate: boolean}|null} `null` when the
 *   character at `index` does not open a string literal
 */
export function readLiteralAt(original, index) {
  const quote = original[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const end = skipQuoted(original, index);
  return { raw: original.slice(index + 1, end - 1), isTemplate: quote === '`' };
}

/**
 * Read `key: value` out of an object literal.
 *
 * `maskedText` and `originalText` are the same span of the file — the masked
 * copy has string bodies blanked, the original keeps them. Offsets align.
 *
 * @param {string} maskedText
 * @param {string} originalText
 * @param {string} key
 * @returns {{raw: string, isTemplate: boolean}|null}
 */
export function readObjectValue(maskedText, originalText, key) {
  const re = new RegExp(`(^|[^\\w$])${key}\\s*:`, 'g');
  const match = re.exec(maskedText);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (i < maskedText.length && /\s/.test(maskedText[i])) i += 1;
  return readLiteralAt(originalText, i);
}

/**
 * Read the first argument of a call as *text*, without requiring it to be a
 * literal.
 *
 * The offsets come from the masked copy — its string bodies are blanked, so
 * the first non-whitespace character is the first argument's first
 * character. The text itself is taken from the original, so a string
 * argument keeps its quotes.
 *
 * Callers use it to tell a bare identifier (`url`) apart from a computed
 * expression (`` `/assets/${id}` ``).
 *
 * @param {string} original the untouched source
 * @param {string} masked the masked source (same offsets)
 * @param {number} argsStart index of the opening `(`
 * @returns {string|null} the trimmed argument text, or `null` when there is none
 */
export function readFirstArgumentText(original, masked, argsStart) {
  const range = readBalancedRange(masked, argsStart);
  if (range === null) return null;

  let valueStart = range.start;
  while (valueStart < range.end && /\s/.test(masked[valueStart])) valueStart += 1;
  if (valueStart >= range.end) return null;

  let depth = 0;
  let end = valueStart;
  for (; end < range.end; end += 1) {
    const ch = masked[end];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) break;
  }
  const text = original.slice(valueStart, end).trim();
  return text.length > 0 ? text : null;
}

/**
 * Read the value of `key` out of an object literal as *text*.
 *
 * @param {string} originalText the object literal, untouched
 * @param {string} key
 * @returns {string|null} the trimmed value text, or `null` when the key is absent
 */
export function readObjectValueText(originalText, key) {
  const re = new RegExp(`(^|[^\\w$])${key}\\s*:`, 'g');
  const match = re.exec(originalText);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (i < originalText.length && /\s/.test(originalText[i])) i += 1;

  let depth = 0;
  let end = i;
  for (; end < originalText.length; end += 1) {
    const ch = originalText[end];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
  }
  const text = originalText.slice(i, end).trim();
  return text.length > 0 ? text : null;
}

/**
 * The keywords whose parenthesised head is never a parameter list.
 */
const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'new', 'do', 'else', 'case', 'yield', 'delete', 'void', 'in', 'of',
]);

/**
 * Every identifier that names a parameter of a function in this file.
 *
 * A path that comes from a parameter can only ever be known at runtime — the
 * function receives it from its caller. Those call sites are *forwarders*:
 * `apiGet(url)` inside `apiGet`, `apiClient.request({ url: path })` inside
 * `useApi`. They do not name a route, so they are not a coverage gap; the
 * call sites that pass a literal into them are checked separately.
 *
 * The set is collected per file and is deliberately permissive: an identifier
 * that merely happens to share a name with a parameter somewhere in the file
 * is treated as a parameter. Both outcomes mean "runtime-dependent", so the
 * imprecision cannot turn a real gap into a false pass.
 *
 * @param {string} masked the masked source
 * @returns {Set<string>}
 */
export function collectParameterNames(masked) {
  const names = new Set();
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '(') continue;

    // The identifier right in front of the bracket decides whether this is
    // a parameter list or a control statement.
    let cursor = i - 1;
    while (cursor >= 0 && /\s/.test(masked[cursor])) cursor -= 1;
    let word = '';
    while (cursor >= 0 && /[\w$]/.test(masked[cursor])) {
      word = masked[cursor] + word;
      cursor -= 1;
    }
    if (word !== '' && CONTROL_KEYWORDS.has(word)) continue;

    const range = readBalancedRange(masked, i);
    if (range === null) continue;

    // Skip over a return type annotation — `(): Promise<T> {` — before
    // deciding what follows the parameter list. `range.end` points at the
    // closing bracket itself, so the scan starts just past it.
    let after = range.end + 1;
    while (after < masked.length && /\s/.test(masked[after])) after += 1;
    let depth = 0;
    let isArrow = false;
    let isMethodBody = false;
    while (after < masked.length) {
      const ch = masked[after];
      if (depth === 0 && ch === '=' && masked[after + 1] === '>') {
        isArrow = true;
        break;
      }
      if (ch === '(' || ch === '[' || ch === '<') {
        depth += 1;
        after += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '>') {
        if (depth === 0) break;
        depth -= 1;
        after += 1;
        continue;
      }
      if (depth === 0 && ch === '{') {
        isMethodBody = true;
        break;
      }
      if (depth === 0 && ch === ';') break;
      after += 1;
    }
    if (!isArrow && !isMethodBody) continue;

    for (const name of collectIdentifiers(masked.slice(range.start, range.end))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Split a call's argument list on the top-level commas.
 *
 * The text must already be masked — commas inside a string body or inside a
 * nested bracket never split an argument.
 *
 * @param {string} maskedText the text between the call's parentheses
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function splitTopLevelArgs(maskedText) {
  const ranges = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < maskedText.length; i += 1) {
    const ch = maskedText[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      ranges.push({ start, end: i });
      start = i + 1;
    }
  }
  ranges.push({ start, end: maskedText.length });
  return ranges.map((range) => ({
    start: range.start,
    end: range.end,
    text: maskedText.slice(range.start, range.end),
  }));
}

/**
 * Recursively collect every `.ts` / `.tsx` file below `dir`.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
export function collectSourceFiles(dir) {
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
 * Collapse a path to the shape used for comparison: query string removed,
 * parameters unified to `:p`, trailing slashes dropped.
 *
 * @param {string} rawPath
 * @param {boolean} isTemplate whether the literal was a backtick template
 * @returns {string}
 */
export function normalizePath(rawPath, isTemplate) {
  let value = rawPath.split('?')[0];
  if (isTemplate) value = value.replace(/\$\{[^}]*\}/g, ':p');
  return value.replace(/:[A-Za-z_][\w]*/g, ':p').replace(/\/+$/, '') || '/';
}

/**
 * Strip the `/api/v1` prefix the axios baseURL already carries.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripBasePrefix(value) {
  if (value === '/api/v1') return '/';
  if (value.startsWith('/api/v1/')) return value.slice('/api/v1'.length);
  return value;
}

/**
 * Every identifier-like token in a piece of source.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function collectIdentifiers(text) {
  const found = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  let match;
  while ((match = re.exec(text)) !== null) found.add(match[0]);
  return found;
}
