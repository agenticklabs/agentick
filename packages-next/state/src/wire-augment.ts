/**
 * Wire-method augmentation — adds the `state/*` rows to the spec `WireMethods`
 * seed. Split out from the server-bridge {@link ./augment.ts} so a future CLIENT
 * subpath (a `session.state` client handle, three-audiences-plan §G) can type
 * `state/get` / `state/list` / `state/set` / `state/delete` WITHOUT loading the
 * server-bridge augmentations.
 *
 * Pure type-only augmentation (zero runtime) — a browser bundle importing it as
 * a side effect pulls no server code. Mirrors `@agentick/tasks-next`'s
 * `wire-augment.ts`.
 *
 * The `export {}` is load-bearing: without a top-level import/export this file
 * is a SCRIPT, and `declare module "@agentick/spec-next"` would be read as an
 * ambient module declaration that SHADOWS the real spec module (every export
 * vanishes) instead of merging into it. The empty export makes it a module, so
 * the block is a merging augmentation.
 */

import type { StateListEntry } from "@agentick/spec-next";

export {};

declare module "@agentick/spec-next" {
  interface WireMethods {
    /**
     * Read one value by key. `undefined`/absent read back the same (state
     * conflates absent and unset, distinguished only by `has` — not a wire verb).
     */
    "state/get": { params: { sessionId: string; key: string }; result: unknown };
    /** Every entry as `{ key, value }` (the family projection depth). */
    "state/list": { params: { sessionId: string }; result: readonly StateListEntry[] };
    /** Set a value through the harness's journaled Operation. */
    "state/set": { params: { sessionId: string; key: string; value: unknown }; result: null };
    /** Delete a key through the harness's journaled Operation. */
    "state/delete": { params: { sessionId: string; key: string }; result: null };
  }
}
