/** The shape the rule forbids: the token is parked in browser storage. */
const TOKEN_STORAGE_KEY = 'dam_init_token';

let initToken = '';

export function setInitToken(token: string): void {
  initToken = token;
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function readInitToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || initToken;
}
