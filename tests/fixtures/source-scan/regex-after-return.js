/**
 * A regular expression right after `return`.
 *
 * The slash follows an identifier, so a naive "an identifier means division"
 * rule would read this as arithmetic — and then the quote inside the literal
 * would swallow the rest of the file.
 */
function hasQuote(value) {
  return /"quoted"/.test(value);
}

router.get('/quoted', (_req, res) => res.json({ ok: hasQuote('x') }));
