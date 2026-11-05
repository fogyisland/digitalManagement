/**
 * The setup wizard's init token must never reach browser storage.
 *
 * `X-Init-Token` is minted per boot and is the *only* thing standing between
 * an anonymous caller and the creation of the platform administrator. It is
 * deliberately one-shot: the backend prints it to the console, the operator
 * pastes it into the wizard, and the wizard stops being reachable once the
 * instance is initialised.
 *
 * `localStorage`, `sessionStorage`, `indexedDB` and `document.cookie` are all
 * readable by any script that ever runs on the origin, and all of them outlive
 * the tab. A token parked there is a token that can still be found after the
 * operator closes the browser — which turns a credential that expires with
 * the boot into a credential that waits on disk for the next person to open
 * devtools.
 *
 * `src/client/api/client.ts` stores the *session* tokens on purpose; they are
 * bound to a real account and are rotated. The init token is a different
 * animal, so the rule is scoped to the wizard's own directory rather than to
 * the whole client tree.
 *
 * The scan runs on the masked source, so a comment that names `localStorage`
 * — including the one in `initApi.ts` that promises never to use it — is not a
 * violation and not a false pass.
 */

import fs from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, maskSource } from './source-scan.js';

/**
 * The browser storage sinks the wizard must stay clear of.
 *
 * Each pattern is matched against the masked source; `name` is what the
 * report prints, so the operator can see which sink was reached for.
 */
const STORAGE_SINKS = [
  { name: 'localStorage', pattern: /\blocalStorage\b/g },
  { name: 'sessionStorage', pattern: /\bsessionStorage\b/g },
  { name: 'the IndexedDB API', pattern: /\bindexedDB\b/g },
  { name: 'document.cookie', pattern: /\bdocument\s*\.\s*cookie\b/g },
];

/**
 * Which line a character offset falls on.
 *
 * @param {string} text
 * @param {number} index
 * @returns {number} 1-based line number
 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Every place the setup wizard reaches for browser storage.
 *
 * @param {{initDir: string, repoRoot: string}} input `initDir` is the
 *   absolute path of `src/client/pages/init`; `repoRoot` is used to print
 *   repo-relative paths like the other lints do
 * @returns {string[]} one line per violation, empty when the wizard is clean
 */
export function findInitTokenStorageProblems({ initDir, repoRoot }) {
  const problems = [];

  for (const file of collectSourceFiles(initDir)) {
    const original = fs.readFileSync(file, 'utf8');
    const masked = maskSource(original);
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');

    for (const sink of STORAGE_SINKS) {
      const scan = new RegExp(sink.pattern.source, 'g');
      let match;
      while ((match = scan.exec(masked)) !== null) {
        problems.push(
          `${relative}:${lineOf(masked, match.index)} — the setup wizard touches ${sink.name}; ` +
            'the init token grants the creation of the platform administrator, so it stays ' +
            'in memory for the length of the page and is never written to browser storage',
        );
      }
    }
  }

  return problems.sort();
}
