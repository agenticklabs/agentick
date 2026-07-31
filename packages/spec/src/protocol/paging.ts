/**
 * The normalized cursor-paging envelope — and the ownership rule that says who
 * gets to decide what a cursor MEANS.
 *
 * **The framework defines the envelope. The source defines the semantics.**
 * `{ cursor?, limit }` in, `{ items, nextCursor? }` out is the whole of the
 * framework's contribution to a paged read. What the token encodes — a keyset, a
 * seek offset, a Postgres snapshot id, a vendor continuation string — belongs to
 * whoever produced it, and callers pass it back verbatim.
 *
 * **The cursor belongs to whoever owns the ORDERING.** That one rule resolves
 * every case, including the awkward ones:
 *
 *   - A store that implements a cursored read owns its own ordering, so it mints
 *     its own cursor. The framework hands the token back untouched.
 *   - A store that does NOT implement one hands over a bounded snapshot, so the
 *     framework must impose an order to page it at all — and therefore mints the
 *     cursor itself (see `sessionKeysetPage`, the default realization).
 *   - A merger over N independently-ordered sources CANNOT use the sources'
 *     opaque tokens: it has no way to know how far into each one it consumed
 *     when only some of their rows made the emitted page, and an opaque token
 *     does not rewind. So a merger owns the merged ordering by necessity, and
 *     mints the merged cursor.
 *
 * The obligations that make a cursor trustworthy — walk the pages and every row
 * that stayed put appears exactly once, none appears twice, under writes
 * interleaved with the walk — are shipped as CONFORMANCE TESTS the adopter's
 * implementation must pass, not as framework code that would have to understand
 * the token to enforce them.
 *
 * Deliberately NOT applied to `timeline/history`: the framework owns the
 * timeline's ordering (a store-assigned `seq`, monotonic by construction), so
 * the cursor there is the framework's and stays a seq. The rule is the same one;
 * it just resolves the other way.
 *
 * @see docs/proposals/v2/STATUS.md — the cursor-ownership entry
 */

/**
 * The paging half of any cursored request. Carried alongside the read's own
 * query rather than folded into it: the query says WHICH records, this says HOW
 * MANY and FROM WHERE, and keeping them separate is what lets one query type
 * serve both a snapshot read and a paged one.
 */
export interface PageRequest {
  /**
   * Opaque token from a prior reply's `nextCursor`; absent starts at page one.
   *
   * Opaque means opaque: it is the producing source's to encode and may change
   * shape without notice. Pass it back verbatim, never parse it, and never mint
   * one. A source that cannot decode a token SHOULD answer page one rather than
   * raise — a caller holding a stale or corrupted cursor has no recovery path
   * from an error, and page one is a walk it can finish.
   */
  readonly cursor?: string;
  /** Maximum rows in the page. A source may return fewer; it must not return more. */
  readonly limit?: number;
}

/**
 * One page of a cursored read.
 *
 * `nextCursor`'s PRESENCE is the "there is more" signal — never the page's
 * length. A page can be exactly `limit` long and still be the last one, and a
 * source under a filter may legitimately return a short page with more behind
 * it. Callers walk until the cursor is absent.
 *
 * Named for the cursor to keep it distinct from `@agentick/utils`'s offset
 * `Page`, which is the mechanism for catalog surfaces whose order does not move.
 */
export interface CursorPage<T> {
  readonly items: readonly T[];
  /** Token that fetches the next page; absent on the last one. */
  readonly nextCursor?: string;
}
