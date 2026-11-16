/**
 * A link that names nothing — one violation.
 *
 * This is the shape the settings page had: an address that is not a page, not
 * a route and not a file, advertised as if it were a document.
 */
export function Example() {
  return <a href="/docs">Swagger UI</a>;
}
