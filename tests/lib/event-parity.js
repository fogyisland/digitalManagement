/**
 * Webhook event vocabulary parity.
 *
 * The list of events exists twice: `WEBHOOK_EVENTS` in
 * `src/server/lib/webhook.js` (what the backend accepts and emits) and
 * `WEBHOOK_EVENTS` in `src/client/api/webhooks.ts` (what the UI offers). The
 * spec requires the two to be identical, and the consequence of drift is
 * concrete in both directions:
 *
 *   - an event the UI offers but the backend rejects is a subscription the
 *     user can pick and can never satisfy — the backend answers 400;
 *   - an event the backend emits but the UI never offers is invisible: no
 *     endpoint can subscribe to it, so it is dead weight in the vocabulary.
 *
 * The check reads both arrays as source text rather than importing them: one
 * is CommonJS, the other TypeScript, and the guard runs under the ESM test
 * runner. Parsing a list of quoted strings is the whole job.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the two lists live, relative to the repository root. */
const BACKEND_FILE = path.join('src', 'server', 'lib', 'webhook.js');
const FRONTEND_FILE = path.join('src', 'client', 'api', 'webhooks.ts');

/**
 * Read the string literals of the array assigned to `WEBHOOK_EVENTS`.
 *
 * Works for both `const WEBHOOK_EVENTS = [...]` and
 * `export const WEBHOOK_EVENTS: WebhookEvent[] = [...] }: the array starts at
 * the first `[` after the declaration and ends at its matching `]`.
 *
 * @param {string} source
 * @param {string} label used in the error messages
 * @returns {string[]|null} null when the declaration is not found
 */
function readVocabulary(source, label) {
  const declaration = /(?:export\s+)?const\s+WEBHOOK_EVENTS\b[^=]*=\s*\[/.exec(source);
  if (declaration === null) return null;
  const openIndex = declaration.index + declaration[0].length - 1;

  let depth = 0;
  let end = -1;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`${label}: WEBHOOK_EVENTS has no closing bracket`);
  }

  const body = source.slice(openIndex + 1, end);
  // Strip line and block comments so a commented-out event does not count.
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  return [...withoutComments.matchAll(/'([^']+)'|"([^"]+)"/g)].map(
    (match) => match[1] ?? match[2],
  );
}

/**
 * Compare the two vocabularies.
 *
 * @param {{repoRoot: string}} input
 * @returns {string[]} the violations, empty when the two agree
 */
export function findEventVocabularyDrift({ repoRoot }) {
  const backendPath = path.join(repoRoot, BACKEND_FILE);
  const frontendPath = path.join(repoRoot, FRONTEND_FILE);

  const violations = [];
  if (!fs.existsSync(backendPath)) {
    violations.push(`${BACKEND_FILE} is missing — the backend vocabulary cannot be read`);
  }
  if (!fs.existsSync(frontendPath)) {
    violations.push(`${FRONTEND_FILE} is missing — the frontend vocabulary cannot be read`);
  }
  if (violations.length > 0) return violations;

  const backend = readVocabulary(fs.readFileSync(backendPath, 'utf8'), BACKEND_FILE);
  const frontend = readVocabulary(fs.readFileSync(frontendPath, 'utf8'), FRONTEND_FILE);
  if (backend === null) {
    violations.push(`${BACKEND_FILE}: no WEBHOOK_EVENTS array found`);
  }
  if (frontend === null) {
    violations.push(`${FRONTEND_FILE}: no WEBHOOK_EVENTS array found`);
  }
  if (backend === null || frontend === null) return violations;

  const backendSet = new Set(backend);
  const frontendSet = new Set(frontend);
  for (const event of backend) {
    if (!frontendSet.has(event)) {
      violations.push(
        `${FRONTEND_FILE}: "${event}" is emitted by the backend but the UI never offers it`,
      );
    }
  }
  for (const event of frontend) {
    if (!backendSet.has(event)) {
      violations.push(
        `${BACKEND_FILE}: "${event}" is offered by the UI but the backend would answer 400`,
      );
    }
  }
  if (violations.length === 0 && backend.length !== new Set(backend).size) {
    violations.push(`${BACKEND_FILE}: WEBHOOK_EVENTS contains a duplicate`);
  }
  if (violations.length === 0 && frontend.length !== new Set(frontend).size) {
    violations.push(`${FRONTEND_FILE}: WEBHOOK_EVENTS contains a duplicate`);
  }
  return violations;
}
