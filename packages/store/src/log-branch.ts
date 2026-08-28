import type { LogStore, StoreCtx } from "@agentick/spec";

/**
 * The plain-log fork transport: copy `source`'s prefix (`seq <= toSeq`,
 * inclusive; absent ⇒ whole; `-1` ⇒ nothing) into `target`. Bounded THROUGH
 * `history`, never by array position — a log's seqs need not start at 0 and
 * its `read` may be a window. Idempotent by destination.
 *
 * The implementation every bundled log adapter uses for {@link LogStore.branch};
 * a store with lineage of its own records an edge instead and never calls this.
 */
export async function copyLogPrefix<T>(
  store: LogStore<T>,
  source: string,
  target: string,
  opts: { readonly toSeq?: number },
  ctx: StoreCtx,
): Promise<void> {
  if ((await store.read(target, ctx)).length > 0) return;
  const { toSeq } = opts;
  if (toSeq !== undefined && toSeq < 0) return;
  let prefix: readonly T[];
  if (toSeq === undefined) {
    prefix = await store.read(source, ctx);
  } else {
    if (store.history === undefined) {
      throw new Error(
        `${store.backend}: a seq-bounded branch needs history() — implement it (runTimelineStoreConformance covers it)`,
      );
    }
    prefix = (await store.history(source, { toSeq }, ctx)).map((t) => t.entry);
  }
  if (prefix.length === 0) return;
  await store.append(target, prefix, ctx);
}
