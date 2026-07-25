/**
 * `TimelineStore` — the durable backing for the timeline **persisted tier**
 * (ADR 49, "stores, not snapshots"). The flagship instance of the LOG
 * archetype: `TimelineStore extends LogStore<TimelineEntry>` (data-layer plan
 * §6-D — the port home is spec-next, unifying it with `TaskStore`).
 *
 * **Its `logKey` IS the `sessionId`.** One store instance serves every session
 * the harness hosts; entries are keyed by `sessionId` and ordered by the
 * archetype's frozen `seq` (see {@link LogStore}). The timeline is a per-session
 * append-only event log — recovery is a fold over that log, compaction operates
 * on the *projection* tier only and never touches the store, and the one
 * destructive operation ({@link LogStore.prune}) is for retention / GDPR-class
 * erasure, **never called by compaction**.
 *
 * Reference adapters ship as separate packages (ADR 49 §"reference adapters"):
 * `@agentick/timeline-fs` (JSONL, local pole), `-sqlite-next` (recommended
 * first durable), `-postgres-next` (cloud pole). The bundled default is
 * `MemoryTimelineStore` (`@agentick/timeline`), a thin binding of the
 * generic `MemoryLog<T>` (`@agentick/store`).
 *
 * This interface adds **no members** to `LogStore<TimelineEntry>` — it is a
 * semantic binding that fixes the entry type and documents the `logKey =
 * sessionId` convention. It exists so adopters and adapters name the concrete
 * timeline port (`TimelineStore`) rather than the raw archetype, exactly as
 * `TaskStore extends CollectionStore<…>` names the concrete task port.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 * @see docs/proposals/v2/data-layer-plan.md §2.7, §6-D
 */

import type { TimelineEntry } from "./session-harness.js";
import type { LogStore } from "./log-store.js";

/**
 * Adopter-pluggable durable backing for the timeline persisted tier — an
 * APPEND-ONLY event log keyed by `sessionId`, ordered by `seq`. The concrete
 * {@link LogStore} binding for {@link TimelineEntry}. See the file docs for the
 * `logKey = sessionId` convention and the reference adapters.
 */
export interface TimelineStore extends LogStore<TimelineEntry> {}
