/**
 * A link whose target is built at runtime, naming a parameterised page —
 * no violation.
 *
 * The parameter is a hole in the path, so the check compares the *shape* of
 * the two: `/library/:p` is the same route as `/library/:id`.
 */
export function Example({ id }: { id: string }) {
  return <a href={`/library/${id}`}>详情</a>;
}
