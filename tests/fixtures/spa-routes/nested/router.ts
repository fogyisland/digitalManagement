/**
 * A router with a page *below* the mounted path.
 *
 * The collision is not only about the exact path: a mount claims everything
 * under it, so `/mcp/tokens` is answered by the MCP transport as well.
 */
export const router = [
  { path: '/login', element: 'login' },
  { path: 'mcp/tokens', element: 'mcp' },
];
