/**
 * Offset pagination over an in-memory list — the ONE mechanism every wire and
 * projection surface in the framework pages with.
 *
 * The law it serves: a harness's synchronous `list()` stays a BOUNDED snapshot
 * (the `Enumerable` contract — iterate bounded, observe unbounded); pagination
 * is a WIRE and PROJECTION concern. So the caller holds the whole sorted
 * snapshot already and only needs to slice it deterministically — which is why
 * this takes an array rather than a query.
 *
 * The cursor is the decimal string of the NEXT offset: opaque to callers, cheap
 * to produce, and stable as long as the caller's sort order is. It is not a
 * keyset cursor — items inserted before the offset between pages shift the
 * window. That is the accepted trade for a catalog surface whose pages are
 * walked in one pass.
 */

/** Page size used when a caller doesn't name one. Matches MCP's practical default. */
export const DEFAULT_PAGE_SIZE = 100;

/** One page plus the cursor that fetches the next; `nextCursor` absent on the last page. */
export interface Page<T> {
  readonly page: readonly T[];
  readonly nextCursor: string | undefined;
}

/**
 * Slice `all` into the page starting at the offset encoded by `cursor`.
 *
 * A cursor that doesn't decode to a non-negative offset (garbage, negative,
 * empty) starts from the beginning rather than throwing — a client that
 * round-trips a stale or corrupted cursor gets page one, not an error it has no
 * recovery path for. `Number.parseInt` semantics: a leading-numeric string
 * (`"5x"`) decodes to its prefix.
 *
 * @verifiedBy packages/utils/src/__tests__/paginate.spec.ts
 */
export function paginate<T>(
  all: readonly T[],
  cursor: string | undefined,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Page<T> {
  const start = cursor !== undefined ? Number.parseInt(cursor, 10) : 0;
  const offset = Number.isNaN(start) || start < 0 ? 0 : start;
  const page = all.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const nextCursor = nextOffset < all.length ? String(nextOffset) : undefined;
  return { page, nextCursor };
}
