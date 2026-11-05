/** The shape the wizard is supposed to have: the token lives in memory. */
let initToken = '';

export function setInitToken(token: string): void {
  initToken = token;
}

export function getInitToken(): string {
  return initToken;
}
