/**
 * The timeline's WIRE contract — the `WireMethods` rows the dynamic command lane
 * projects, plus the shapes they carry.
 *
 * Split out from the server-bridge {@link ./augment.ts} so the CLIENT subpath can
 * type `timeline/history` WITHOUT loading the server-bridge augmentations (the
 * `session.timeline` handle issues `client.transport.request("timeline/history",
 * …)`). Pure type-only augmentation (zero runtime) — a browser bundle importing
 * it as a side effect pulls no server code. Mirrors `@agentick/tasks`'s
 * `wire-augment.ts`.
 *
 * Every row here is a DECLARED COMMAND on the harness (`exposure: "wire"`), not a
 * gateway-resident porcelain method: one declaration produces the inbox message
 * type, the op name, the authz scope label, and this wire method (ADR 51 §2).
 * Reaching any of them therefore requires a GRANT on the verb's scope label —
 * `timeline:history`, `timeline:compact` — and the same-principal target rule
 * gates the addressed session (ADR 48). Deny by default: no grant, no read.
 *
 * The exported types below are load-bearing beyond their own use: without a
 * top-level import/export this file would be a SCRIPT, and
 * `declare module "@agentick/spec"` would be read as an ambient module
 * declaration that SHADOWS the real spec module (every export vanishes). They
 * make it a module, so the block is a merging augmentation. Do not leave this
 * file export-less.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md §"The client read doors"
 */

import type { CommandInfo, SeqTagged, TimelineEntry } from "@agentick/spec";

/**
 * The cursored page request — `timeline:history`'s payload.
 *
 * `fromSeq` is the cursor LOWER BOUND: entries with absolute `seq >= fromSeq`
 * (omit → from the log's start). `limit` caps the page (omit → uncapped, and the
 * reply then carries no `nextFromSeq` because it reached the tail). Both are
 * serializable scalars — the whole payload is, which is what makes this read
 * addressable at all (the signal-form rule, ADR 51 §1.2).
 */
export interface TimelineHistoryInput {
  /** Entries with absolute `seq >= fromSeq`. Omit → from the log's start. */
  readonly fromSeq?: number;
  /** Cap on entries in this page. Omit → uncapped (the store's own bound). */
  readonly limit?: number;
}

/**
 * One cursored page of the durable log. `entries` are seq-ordered and carry the
 * store's frozen `seq` — the ordering identity a client pages by.
 *
 * `nextFromSeq` is the cursor to pass as the next `fromSeq`, present IFF the page
 * was capped by `limit` (so there may be more) and absent once the page reached
 * the log's tail. Because `seq` is strictly increasing but MAY be sparse (a
 * `BIGSERIAL` gap, a `prune`), it is `lastSeq + 1` — a valid lower bound, never a
 * claim that the entry at that seq exists.
 *
 * The reply carries its own next action: `nextFromSeq` present means "call again
 * with this"; absent means "you have the whole log".
 */
export interface TimelineHistoryPage {
  readonly entries: readonly SeqTagged<TimelineEntry>[];
  /** Next `fromSeq` when the page was capped; absent at the log's tail. */
  readonly nextFromSeq?: number;
}

declare module "@agentick/spec" {
  interface WireMethods {
    /**
     * Read a cursored, bounded page of this session's DURABLE timeline log — the
     * client scroll-back door (ADR 93 §"The client read doors"). Side-effect-free
     * req-res; the harness flushes its write-behind buffer first, so a page
     * reflects every completed append.
     *
     * Grant-gated on `timeline:history` and scoped to the addressed session by
     * the same-principal target rule. `session.timeline.history()` /
     * `loadOlder()` are the typed client faces.
     */
    "timeline/history": {
      params: { sessionId: string } & TimelineHistoryInput;
      result: TimelineHistoryPage;
    };
    /** The flagship signal form: bare verb + optional advisory instructions. */
    "timeline/compact": {
      params: { sessionId: string; instructions?: string };
      result: unknown;
    };
    "timeline/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
