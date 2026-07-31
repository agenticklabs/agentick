/**
 * The canonical session ORDER, and the framework's default realization of a
 * cursor over it.
 *
 * Two different things live here, and the split is the point (see
 * {@link ./paging.ts} for the ownership rule they instantiate):
 *
 *   - **{@link compareSessionRecords} is CONTRACT.** A `SessionStore.page`
 *     implementation must return rows in this order. Not because the framework
 *     wants to dictate presentation, but because N stores get MERGED at the
 *     gateway when no cross-app index is mounted, and a merge needs one order
 *     every source agrees on. The conformance suite pins it.
 *   - **{@link sessionKeysetPage} is a DEFAULT, not the contract.** It is how the
 *     bundled in-memory store, and the framework's own fallbacks, realize a
 *     cursor over that order. An adapter is free to mint an entirely different
 *     token — a Postgres keyset over an index, a snapshot id — as long as it
 *     returns rows in the contract order and passes the conformance obligations.
 *
 * A `SessionIndex` (the gateway's cross-app door) is under NEITHER: nothing
 * merges its output, so its ordering is adopter policy and its cursor is
 * entirely its own.
 *
 * **Why keyset for the default.** Sessions sort by last activity, which MOVES —
 * a thread that receives a message mid-walk jumps to the front and pushes every
 * row behind it down one. An offset cursor then re-serves rows the caller
 * already holds. A keyset cursor holds a VALUE in the list (the last row's sort
 * key) rather than a count of rows before it, so the walk keeps its place no
 * matter what moves behind it. Rows that move AHEAD of the cursor are not seen
 * again on that walk — they sorted into a region already passed, which is the
 * keyset guarantee rather than a gap in it.
 */

import type { CursorPage, PageRequest } from "./paging.js";
import type { SessionRecord } from "./session-store.js";

/** Page size used when a caller names none. Matches the framework-wide default. */
export const DEFAULT_SESSION_PAGE_SIZE = 100;

/**
 * The sort key of one session — last activity, then two tiebreakers that make
 * the order TOTAL.
 *
 * `updatedAt` alone is not a key: ms-epoch stamps collide on bulk creates, and
 * two sessions sharing one leave a cursor unable to say which side of the tie it
 * sits on. `id` breaks nearly every remaining tie; `appId` finishes the job at
 * the gateway, where two apps CAN hold the same session id (ids are unique
 * within one app's store, not across a union of them).
 */
interface SessionKey {
  readonly updatedAt: number;
  readonly id: string;
  readonly appId: string;
}

function keyOf(record: SessionRecord): SessionKey {
  return { updatedAt: record.updatedAt, id: record.id, appId: record.appId ?? "" };
}

function compareKeys(a: SessionKey, b: SessionKey): number {
  // Newest first — a thread list is a recency list.
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.appId !== b.appId) return a.appId < b.appId ? -1 : 1;
  return 0;
}

/**
 * The CONTRACT order for session reads: `updatedAt` descending, ties broken by
 * `id` then `appId` ascending. Total, and stable across apps as well as within
 * one — which is what lets a gateway merge N stores into a single list with a
 * single position.
 *
 * Every `SessionStore.page` implementation must return rows in this order.
 * `runSessionStoreConformance` asserts it.
 */
export function compareSessionRecords(a: SessionRecord, b: SessionRecord): number {
  return compareKeys(keyOf(a), keyOf(b));
}

/** Sort a snapshot into {@link compareSessionRecords} order without mutating it. */
export function sortSessionRecords<T extends SessionRecord>(records: readonly T[]): readonly T[] {
  return [...records].sort(compareSessionRecords);
}

// ============================================================================
// The default keyset cursor
// ============================================================================

/**
 * Cursor wire format: a version tag and the three key components, delimited.
 *
 * Deliberately NOT base64: the token is opaque BY CONTRACT, not by obfuscation,
 * and a plain delimited string works identically in every runtime (`Buffer` is a
 * Node global, and `@agentick/spec` is imported by browser client code). The
 * version tag is what lets a future format change reject an old token cleanly
 * instead of misreading it.
 */
const CURSOR_TAG = "sk1";
const CURSOR_SEP = ":";

function encodeCursor(key: SessionKey): string {
  return [
    CURSOR_TAG,
    String(key.updatedAt),
    encodeURIComponent(key.id),
    encodeURIComponent(key.appId),
  ].join(CURSOR_SEP);
}

/**
 * Decode a cursor back to its key, or `undefined` if it is not one of ours.
 *
 * Garbage, truncated, and foreign-format tokens all resolve to `undefined` —
 * page one — rather than throwing, per the {@link PageRequest.cursor} contract.
 */
function decodeCursor(cursor: string | undefined): SessionKey | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const parts = cursor.split(CURSOR_SEP);
  if (parts.length !== 4 || parts[0] !== CURSOR_TAG) return undefined;
  const updatedAt = Number(parts[1]);
  if (!Number.isFinite(updatedAt)) return undefined;
  try {
    return {
      updatedAt,
      id: decodeURIComponent(parts[2]!),
      appId: decodeURIComponent(parts[3]!),
    };
  } catch {
    // A malformed percent-escape — same answer as any other undecodable token.
    return undefined;
  }
}

/**
 * The framework's default keyset page over a snapshot ALREADY sorted by
 * {@link compareSessionRecords}.
 *
 * The page starts at the first row sorting strictly AFTER the cursor's key — a
 * scan, not an index, which is exactly what makes the walk survive rows moving
 * behind it. A cursor whose own row has since moved or been deleted still lands
 * correctly: the predicate is about the key's POSITION in the order, and every
 * row that key preceded still follows it.
 *
 * Used in three places, all of them cases where the framework owns the ordering
 * because nothing else does: the bundled in-memory store's `page`, the app-level
 * fallback when a store implements no cursored read, and the gateway's k-way
 * merge when no cross-app index is mounted.
 */
export function sessionKeysetPage<T extends SessionRecord>(
  sorted: readonly T[],
  page: PageRequest = {},
): CursorPage<T> {
  const after = decodeCursor(page.cursor);
  const start =
    after === undefined ? 0 : sorted.findIndex((record) => compareKeys(after, keyOf(record)) < 0);
  const from = start < 0 ? sorted.length : start;
  const size =
    page.limit !== undefined && Number.isFinite(page.limit) && page.limit > 0
      ? Math.floor(page.limit)
      : DEFAULT_SESSION_PAGE_SIZE;
  const items = sorted.slice(from, from + size);
  const last = items[items.length - 1];
  const more = from + items.length < sorted.length;
  return {
    items,
    ...(more && last !== undefined ? { nextCursor: encodeCursor(keyOf(last)) } : {}),
  };
}
