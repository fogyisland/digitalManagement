/**
 * Source file length guard.
 *
 * A source file that keeps growing is the one nobody reviews: the reader
 * loses the thread long before the end, and a change gets waved through
 * because the diff's surroundings are unfamiliar. The project's own limit is
 * 500 lines per file (`CLAUDE.md` §1.3), so the build enforces it instead of
 * leaving it to whoever remembers the rule.
 *
 * The measurement is the same one `wc -l` prints: the number of newlines,
 * plus one for a final line that has no trailing newline. A file that grows
 * past the limit is reported with its path and its size, so the fix is a
 * refactor of a named file rather than a hunt.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The project's per-file limit. */
export const MAX_SOURCE_LINES = 500;

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
 * Count the lines of a text the way `wc -l` does.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') newlines += 1;
  }
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Find the source files that are over the limit.
 *
 * @param {{dirs: string[], repoRoot: string, maxLines?: number}} input
 *   `dirs` are absolute directory paths; `repoRoot` is used to print
 *   repo-relative paths like the other lints do
 * @returns {{file: string, lines: number}[]} one entry per oversized file,
 *   sorted by path so the report is stable between runs
 */
export function findOversizedFiles({ dirs, repoRoot, maxLines = MAX_SOURCE_LINES }) {
  const oversized = [];
  for (const dir of dirs) {
    for (const file of collectJsFiles(dir)) {
      const lines = countLines(fs.readFileSync(file, 'utf8'));
      if (lines <= maxLines) continue;
      oversized.push({
        file: path.relative(repoRoot, file).split(path.sep).join('/'),
        lines,
      });
    }
  }
  return oversized.sort((left, right) => left.file.localeCompare(right.file));
}
