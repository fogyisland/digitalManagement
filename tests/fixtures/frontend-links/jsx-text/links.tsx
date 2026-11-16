/**
 * A link that sits *after* JSX text holding a `/*`.
 *
 * `<span>/api/v1/*</span>` is ordinary text, not a comment — but a scanner
 * that reads it as one swallows the rest of the file, and then the links that
 * follow it are never seen. That is how the settings page's two dead links
 * survived a guard that was looking at exactly this file.
 */
export function Example() {
  return (
    <div>
      <span>/api/v1/*</span>
      <a href="/library">资料库</a>
    </div>
  );
}
