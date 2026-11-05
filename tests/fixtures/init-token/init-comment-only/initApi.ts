/**
 * A mention of browser storage that is not a use of it.
 *
 * `src/client/pages/init/initApi.ts` carries exactly this comment — "memory
 * only, never storage" — and a scan that read comments would flag the file
 * that documents the rule as its violator.
 */
let initToken = '';

/** Where the one-shot token is kept: memory only, never localStorage. */
export function setInitToken(token: string): void {
  initToken = token;
}

export function getInitToken(): string {
  return initToken;
}
