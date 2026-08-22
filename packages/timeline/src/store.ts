/**
 * `MemoryTimelineStore` — the bundled, zero-dependency default {@link
 * TimelineStore} (ADR 49, "stores, not snapshots"). The port itself now lives
 * in `@agentick/spec` as `TimelineStore extends LogStore<TimelineEntry>`
 * (the LOG archetype; data-layer plan §6-D, §2.7) — this file holds only the
 * in-memory default.
 *
 * It is a **thin binding of the generic {@link MemoryLog}** (`T =
 * TimelineEntry`, `@agentick/store`): `MemoryLog` already provides the
 * whole `LogStore` surface — per-log `{ entries, baseSeq }` window, the frozen
 * `seq` math, `append`/`read`/`history`/`keys`/`delete`/`prune`, the empty-log
 * enumerate filter, and defensive-copy-on-read — payload-agnostically. The
 * timeline store needs **nothing MemoryLog doesn't already provide**, so this is
 * an empty subclass that fixes the entry type and names the concrete class the
 * harness constructs.
 *
 * `:memory:` semantics (lost on process exit); a full in-memory array per
 * session is the intended default (the framework legislates no memory strategy —
 * §2.7). Suitable for tests and the ephemeral local pole. This is the reference
 * the {@link import("./store-conformance.js").runTimelineStoreConformance} suite
 * validates every durable adapter against.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 * @see MemoryLog — the generic log default this binds.
 */

import type { TimelineEntry, TimelineStore } from "@agentick/spec";
import { MemoryLog } from "@agentick/store";

/**
 * Bundled, zero-dependency {@link TimelineStore} — an in-process append-only
 * log per session (keyed by `sessionId`). The default when no store is
 * injected. Binds {@link MemoryLog} to {@link TimelineEntry}; the log mechanics
 * are entirely the generic's.
 */
export class MemoryTimelineStore extends MemoryLog<TimelineEntry> implements TimelineStore {}

/**
 * The store key for a session's timeline log — the harness's `scopeId`, which
 * is what its `LogView` is keyed by.
 *
 * A branch reads a log belonging to a session OTHER than its own
 * (`BranchCtx.fromSessionId`), so the rule that composes the key stops being
 * the caller's private business and has to be stated once. Composition sites
 * derive from here rather than re-spelling the template.
 */
export function timelineScopeKey(sessionId: string): string {
  return `${sessionId}:timeline`;
}
