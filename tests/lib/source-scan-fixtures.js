/**
 * Fixtures for the source scanner's masking.
 *
 * `maskSource` blanks out comment bodies, string bodies and regular
 * expression bodies, keeping the length and the delimiters so that the
 * offsets in the masked copy still line up with the original. Every scanner
 * in this guard reads the masked copy, so a masking bug is not a cosmetic
 * problem: it makes every check read less than it looked at.
 *
 * That has happened twice:
 *
 *   - a `/*` in JSX text was read as the start of a block comment, and the
 *     rest of the file was swallowed;
 *   - a regular expression whose body held a quote (`/["\\]/`) was read as
 *     the start of a string literal, and the rest of the file was swallowed.
 *
 * The cases below pin the behaviour in both directions: the parts that must
 * still be visible (a route registered after the construct) and the parts
 * that must be gone (the quote inside the literal).
 *
 * Without them a masking rule that quietly stopped matching would look like
 * a file with nothing in it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { maskSource } from './source-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'source-scan');

/**
 * One entry per fixture: what the masked copy must still show, and what it
 * must not.
 */
export const SOURCE_SCAN_CASES = [
  {
    name: 'regex-with-quote',
    // The route's *path* is a string, so it is blanked out like any other
    // string — what has to survive is the code around it.
    visible: ['router.get(', 'res.json([])', 'function clean(value)'],
    hidden: ['"\\\\]'],
    why: 'a regular expression whose body holds a quote must not swallow the file',
  },
  {
    name: 'division',
    visible: ['router.get(', 'res.json({ half, other })', 'const half = total / 2;'],
    hidden: [],
    why: 'a division is arithmetic, not a regular expression',
  },
  {
    name: 'regex-after-return',
    visible: ['router.get(', 'res.json({ ok:'],
    hidden: ['"quoted"'],
    why: 'a regular expression right after `return` is still a regular expression',
  },
];

/**
 * Run every fixture and describe the ones that did not behave as expected.
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findSourceScanFixtureProblems() {
  const problems = [];
  for (const testCase of SOURCE_SCAN_CASES) {
    const file = path.join(FIXTURE_ROOT, `${testCase.name}.js`);
    if (!fs.existsSync(file)) {
      problems.push(`${testCase.name} — the fixture file is missing`);
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    const masked = maskSource(source);

    if (masked.length !== source.length) {
      problems.push(
        `${testCase.name} — the masked copy is ${masked.length} characters, the ` +
          `original is ${source.length}; the offsets have to line up`,
      );
    }

    for (const visible of testCase.visible) {
      if (!masked.includes(visible)) {
        problems.push(
          `${testCase.name} — "${visible}" must still be visible after masking, ` +
            'because ' + testCase.why,
        );
      }
    }

    for (const hidden of testCase.hidden) {
      if (masked.includes(hidden)) {
        problems.push(
          `${testCase.name} — "${hidden}" must be masked out, because ` + testCase.why,
        );
      }
    }
  }
  return problems;
}
