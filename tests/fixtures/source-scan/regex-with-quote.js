/**
 * A regular expression whose body holds a quote.
 *
 * The scanner used to read the quote as the start of a string literal and
 * swallow the rest of the file. Every route registered after this line
 * stopped being seen — so the contract guard reported a route table that was
 * missing a whole file, and nothing said why.
 */
const QUOTES = /["\\]/g;

/**
 * The route has to survive: the scanner must not stop at the regular
 * expression above.
 */
router.get('/assets', (_req, res) => res.json([]));

function clean(value) {
  return String(value).replace(QUOTES, '');
}
