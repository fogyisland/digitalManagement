/**
 * A router whose page sits beside the mounted path, not on it.
 *
 * `/mcp-access` is a sibling of `/mcp`: Express matches the mount on a path
 * *segment* boundary, so a page may start with the same letters as long as
 * the next character is not a separator.
 */
export const router = [
  { path: '/login', element: 'login' },
  { path: 'mcp-access', element: 'mcp' },
];
