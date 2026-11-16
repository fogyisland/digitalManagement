/**
 * A router whose page sits exactly on a mounted path.
 *
 * The MCP page once lived at `/mcp`, which is where the MCP protocol's own
 * endpoint is mounted — the page worked on the click and answered 405 on the
 * reload.
 */
export const router = [
  { path: '/login', element: 'login' },
  { path: 'mcp', element: 'mcp' },
];
