/**
 * A division is not a regular expression.
 *
 * `total / 2` is arithmetic. Reading the slash as the start of a literal
 * would mask everything after it — and the file after it holds the route.
 */
const total = 10;
const half = total / 2;
const other = total / 2 / 1;

router.get('/health', (_req, res) => res.json({ half, other }));
