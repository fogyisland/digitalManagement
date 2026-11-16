/**
 * A link under a path the server owns — no violation.
 *
 * The server mounts `/storage`, which claims everything below it, so a link
 * to a stored file is a link that leads somewhere.
 */
export function Example() {
  return <a href="/storage/originals/example.png">原图</a>;
}
