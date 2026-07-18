/**
 * `MemoryTimelineStore` — the bundled, zero-dependency default {@link
 * TimelineStore} (ADR 49, "stores, not snapshots"). The port itself now lives
 * in `@agentick/spec-next` as `TimelineStore extends LogStore<TimelineEntry>`
 * (the LOG archetype; data-layer plan §6-D, §2.7) — this file holds only the
 * in-memory default.
 *
 * It is a **thin binding of the generic {@link MemoryLog}** (`T =
 * TimelineEntry`, `@agentick/store-next`): `MemoryLog` already provides the
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

import type { TimelineEntry, TimelineStore } from "@agentick/spec-next";
import { MemoryLog } from "@agentick/store-next";

/**
 * Bundled, zero-dependency {@link TimelineStore} — an in-process append-only
 * log per session (keyed by `sessionId`). The default when no store is
 * injected. Binds {@link MemoryLog} to {@link TimelineEntry}; the log mechanics
 * are entirely the generic's.
 */
export class MemoryTimelineStore extends MemoryLog<TimelineEntry> implements TimelineStore {}
