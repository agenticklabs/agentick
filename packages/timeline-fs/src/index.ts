/**
 * `@agentick/timeline-fs` — JSONL file {@link TimelineStore} adapter
 * (ADR 49 reference-adapter rung 2, the local pole).
 *
 * Zero third-party dependencies — Node built-ins only. One append-only
 * `.jsonl` transcript file per session; `seq` is stored per line so it is
 * durable in the file and survives `prune`.
 *
 * ```ts
 * import { createApp } from "@agentick/app";
 * import { fsTimelineStore } from "@agentick/timeline-fs";
 *
 * createApp(Agent, {
 *   model,
 *   timeline: { store: fsTimelineStore({ dir: "./.agentick/transcripts" }) },
 * });
 * ```
 *
 * Per ADR 49's "NO `define*` helper" amendment, this adapter follows the
 * `CredentialsStore` precedent: a factory returning an object that
 * `implements TimelineStore` directly — no intermediate `define*` wrapper.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

export { fsTimelineStore, type FsTimelineStoreOptions } from "./store.js";
