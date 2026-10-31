/**
 * Frontend HTTP call-site extraction.
 *
 * Every request the frontend can make is expressed through one of four
 * shapes, and all four are found here:
 *
 *   1. `apiGet('/x')` / `apiPost('/x')` / `apiPut('/x')` / `apiDelete('/x')`
 *   2. `apiClient.get('/x')` / `http.post('/x')` — the shared instance and
 *      its `http` alias
 *   3. `apiClient.request({ url: '/x', method: 'POST' })`
 *   4. `useApi('/x')` — the data-fetching hook, always a GET
 *
 * A call site whose path is not a plain string literal cannot be checked
 * statically — unless the path can be followed back to the literal it
 * produces. `tests/lib/path-resolver.js` does that for the local
 * definitions the codebase uses (a `const` bound to a template, a path
 * builder that returns one); the resolved sites are then checked like every
 * other one.
 *
 * What is left over is split into two kinds and reported separately:
 *
 *   - **forwarded** — the path is a function parameter, so the site hands on
 *     a path its caller supplied (`apiGet(url)` inside `apiGet`). It names no
 *     route; the call sites that pass a literal into it are checked on their
 *     own.
 *   - **dynamic** — the path is built at runtime from a local value the
 *     resolver cannot follow. It *does* name a route, and the static check
 *     cannot know which one. These are the real coverage gap and are counted
 *     and listed.
 *
 * A guard that claims full coverage while skipping a third of the call sites
 * is worse than no guard at all — hence the explicit accounting.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  maskSource,
  readBalancedRange,
  findCallOpenParen,
  readFirstArgument,
  readFirstArgumentText,
  readObjectValue,
  readObjectValueText,
  collectParameterNames,
  collectSourceFiles,
  normalizePath,
} from './source-scan.js';
import { resolvePathArgument } from './path-resolver.js';

/** The wrapper helpers and the HTTP verb each one maps to. */
export const WRAPPER_METHODS = {
  apiGet: 'GET',
  apiPost: 'POST',
  apiPut: 'PUT',
  apiDelete: 'DELETE',
};

/** The axios instance methods and the HTTP verb each one maps to. */
export const INSTANCE_METHODS = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Is the identifier at `index` a *declaration* rather than a call?
 *
 * `export async function apiGet<T>(url: string)` mentions `apiGet` but never
 * calls it — the call sites are the ones that matter. A declaration is
 * recognised by the keyword in front of it.
 *
 * @param {string} masked the masked source
 * @param {number} index the index of the identifier
 * @returns {boolean}
 */
function isDeclaration(masked, index) {
  const before = masked.slice(0, index).replace(/\s+$/, '');
  return /\b(?:function|const|let|var|class)$/.test(before);
}

/**
 * @typedef {object} CallSite
 * @property {string} file   repo-relative path of the source file
 * @property {number} line   1-based line number
 * @property {string} method the HTTP verb
 * @property {string} rawPath the literal path as written
 * @property {string} path   the normalised path (`:p` for parameters)
 * @property {boolean} isResolved whether the path was written at runtime and
 *   then resolved back to a literal through its local definition
 */

/**
 * @typedef {object} SkippedSite
 * @property {string} file
 * @property {number} line
 * @property {string} reason why the path could not be resolved statically
 * @property {'forwarded'|'dynamic'} kind
 *   `forwarded` — the path comes from a function parameter, so the site is a
 *     generic dispatcher rather than a reference to a particular route.
 *   `dynamic` — the path is built at runtime from a local value; the route it
 *     reaches is unknown to the static check and is a real coverage gap.
 */

/**
 * Is the path a runtime value that names a route, or is it merely handed on
 * from the caller?
 *
 * A path that comes from a parameter is only ever known at runtime, and the
 * site forwards it without naming a route — `apiGet(url)` inside `apiGet`.
 * A path built from a local value *does* name a route, and the static check
 * cannot know which one.
 *
 * @param {string|null} argText the argument as source text
 * @param {Set<string>} parameterNames the parameter names of the file
 * @returns {'forwarded'|'dynamic'}
 */
function classifyDynamicPath(argText, parameterNames) {
  if (argText !== null && /^[A-Za-z_$][\w$]*$/.test(argText) && parameterNames.has(argText)) {
    return 'forwarded';
  }
  return 'dynamic';
}

/**
 * Extract every statically-checkable HTTP call site under `src/`.
 *
 * @param {{srcDir: string, repoRoot: string}} input
 * @returns {{sites: CallSite[], skipped: SkippedSite[]}}
 */
export function parseFrontendCallSites({ srcDir, repoRoot }) {
  const sites = [];
  const skipped = [];

  for (const file of collectSourceFiles(srcDir)) {
    const original = fs.readFileSync(file, 'utf8');
    const masked = maskSource(original);
    const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
    const parameterNames = collectParameterNames(masked);

    const lineAt = (index) => original.slice(0, index).split('\n').length;

    const record = (index, method, rawPath, isTemplate, isResolved = false) => {
      sites.push({
        file: relative,
        line: lineAt(index),
        method,
        rawPath,
        path: normalizePath(rawPath, isTemplate),
        isResolved,
      });
    };

    const skip = (index, reason, kind) => {
      skipped.push({ file: relative, line: lineAt(index), reason, kind });
    };

    /**
     * Resolve a path that was not written as a literal, and either record it
     * as a checked site or report it as a gap.
     *
     * @param {number} index the call site's offset
     * @param {string} method the HTTP verb
     * @param {string} reason what to report if the path stays unresolved
     * @param {string|null} argText the argument as source text
     * @returns {boolean} whether the site was recorded
     */
    const resolveOrSkip = (index, method, reason, argText) => {
      const resolved = resolvePathArgument(masked, original, argText);
      if (resolved !== null) {
        record(index, method, resolved.raw, resolved.isTemplate, true);
        return true;
      }
      skip(index, reason, classifyDynamicPath(argText, parameterNames));
      return false;
    };

    // --- `apiGet('/x')`, `apiPost('/x')`, … -----------------------------
    for (const [name, method] of Object.entries(WRAPPER_METHODS)) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      let match;
      while ((match = re.exec(masked)) !== null) {
        if (isDeclaration(masked, match.index)) continue;
        const parenIndex = findCallOpenParen(masked, match.index + name.length);
        if (parenIndex === null) continue;
        const arg = readFirstArgument(original, masked, parenIndex);
        if (arg === null) {
          resolveOrSkip(
            match.index,
            method,
            `${name}() is called with a path that is not a string literal`,
            readFirstArgumentText(original, masked, parenIndex),
          );
          continue;
        }
        record(match.index, method, arg.raw, arg.isTemplate);
      }
    }

    // --- `apiClient.get('/x')`, `http.post('/x')`, … ---------------------
    const instanceRe = /\b(apiClient|http)\s*\.\s*(get|post|put|delete|patch)\b/g;
    let instanceMatch;
    while ((instanceMatch = instanceRe.exec(masked)) !== null) {
      if (isDeclaration(masked, instanceMatch.index)) continue;
      const method = INSTANCE_METHODS[instanceMatch[2]];
      const parenIndex = findCallOpenParen(masked, instanceMatch.index + instanceMatch[0].length);
      if (parenIndex === null) continue;
      const arg = readFirstArgument(original, masked, parenIndex);
      if (arg === null) {
        resolveOrSkip(
          instanceMatch.index,
          method,
          `${instanceMatch[0]} is called with a path that is not a string literal`,
          readFirstArgumentText(original, masked, parenIndex),
        );
        continue;
      }
      record(instanceMatch.index, method, arg.raw, arg.isTemplate);
    }

    // --- `apiClient.request({ url, method })` ---------------------------
    const requestRe = /\bapiClient\s*\.\s*request\b/g;
    let requestMatch;
    while ((requestMatch = requestRe.exec(masked)) !== null) {
      if (isDeclaration(masked, requestMatch.index)) continue;
      const parenIndex = findCallOpenParen(masked, requestMatch.index + requestMatch[0].length);
      if (parenIndex === null) continue;
      const argsRange = readBalancedRange(masked, parenIndex);
      if (argsRange === null) continue;
      const argsMasked = masked.slice(argsRange.start, argsRange.end);
      const argsOriginal = original.slice(argsRange.start, argsRange.end);
      const braceOffset = argsMasked.indexOf('{');
      if (braceOffset === -1) {
        // Not a request descriptor at all — `apiClient.request(config)` inside
        // the response interceptor, for instance. Nothing to check.
        continue;
      }
      const objectRange = readBalancedRange(argsMasked, braceOffset);
      if (objectRange === null) continue;
      const objectMasked = argsMasked.slice(objectRange.start, objectRange.end);
      const objectOriginal = argsOriginal.slice(objectRange.start, objectRange.end);
      if (!/(^|[^\w$])url\s*:/.test(objectMasked)) continue;
      const urlValue = readObjectValue(objectMasked, objectOriginal, 'url');
      if (urlValue === null) {
        resolveOrSkip(
          requestMatch.index,
          'GET',
          'apiClient.request() has a dynamic url',
          readObjectValueText(objectOriginal, 'url'),
        );
        continue;
      }
      const methodValue = readObjectValue(objectMasked, objectOriginal, 'method');
      if (methodValue === null && /\bmethod\s*:/.test(objectMasked)) {
        skip(requestMatch.index, 'apiClient.request() has a dynamic method', 'dynamic');
        continue;
      }
      const method = methodValue === null ? 'GET' : methodValue.raw.toUpperCase();
      if (!HTTP_METHODS.has(method)) continue;
      record(requestMatch.index, method, urlValue.raw, urlValue.isTemplate);
    }

    // --- `useApi('/x')` — always a GET ----------------------------------
    const useApiRe = /\buseApi\b/g;
    let useApiMatch;
    while ((useApiMatch = useApiRe.exec(masked)) !== null) {
      if (isDeclaration(masked, useApiMatch.index)) continue;
      const parenIndex = findCallOpenParen(masked, useApiMatch.index + 'useApi'.length);
      if (parenIndex === null) continue;
      const arg = readFirstArgument(original, masked, parenIndex);
      if (arg === null) {
        resolveOrSkip(
          useApiMatch.index,
          'GET',
          'useApi() is called with a path that is not a string literal',
          readFirstArgumentText(original, masked, parenIndex),
        );
        continue;
      }
      record(useApiMatch.index, 'GET', arg.raw, arg.isTemplate);
    }
  }

  return { sites, skipped };
}
