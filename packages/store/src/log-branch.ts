import type { LogFrom, LogStore, StoreCtx } from "@agentick/spec";

/**
 * The plain-log fork transport: copy `from.logKey`'s prefix (`seq <= from.seq`,
 * inclusive; `-1` ⇒ nothing) into `target`. Bounded THROUGH `history`, never by
 * array position — a log's seqs need not start at 0 and its `read` may be a
 * window. Idempotent by destination.
 *
 * The implementation every bundled log adapter uses for {@link LogStore.branch};
 * a store with lineage of its own records the edge instead and never calls this.
 * What it costs: the prefix is duplicated per branch, renumbered from the
 * target's counter, and never sees a later prune of the source.
 */
export async function copyLogPrefix<T>(
  store: LogStore<T>,
  target: string,
  from: LogFrom,
  ctx: StoreCtx,
): Promise<void> {
  if ((await store.read(target, ctx)).length > 0) return;
  if (from.seq < 0) return;
  if (store.history === undefined) {
    throw new Error(
      `${store.backend}: a seq-bounded branch needs history() — implement it (runTimelineStoreConformance covers it)`,
    );
  }
  const prefix = (await store.history(from.logKey, { toSeq: from.seq }, ctx)).map((t) => t.entry);
  if (prefix.length === 0) return;
  await store.append(target, prefix, ctx);
}
