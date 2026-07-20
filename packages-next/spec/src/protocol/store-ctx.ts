/**
 * `StoreCtx` — the explicit carrier of runtime scope across the
 * **Effect → Promise boundary** into stores.
 *
 * ## Why this type exists
 *
 * A {@link import("./store.js").CollectionStore} / {@link
 * import("./log-store.js").LogStore} is **Promise-shaped**: its methods return
 * `Promise`, and they run OUTSIDE any Effect fiber (an adopter store hits disk /
 * network via plain async). That means a store method **cannot** read the
 * ambient `RuntimeContext` — the runtime's identity/operation scope is held in a
 * `FiberRef` (`RuntimeContextRef`), reachable only from inside an Effect fiber
 * via `getContext`. A `Promise` continuation is off-fiber; the FiberRef is
 * invisible there (see `@agentick/runtime-next`'s `runtime-context.ts` "honest
 * contract").
 *
 * So the scope must be **passed explicitly**. `StoreCtx` is that parameter — the
 * snapshot of the runtime scope a harness captures at the op boundary and threads
 * as the FINAL argument to every store DATA method. It is the store-side twin of
 * the `ctx` argument that `AsyncMiddleware` already receives explicitly for the
 * same off-fiber reason.
 *
 * ## Import discipline (data-layer plan §6-D)
 *
 * `RuntimeContext` lives in `@agentick/runtime-next`, NOT spec — and spec has
 * **zero** runtime deps (it is the firewall). So `StoreCtx` cannot literally
 * `extends RuntimeContext`. Instead it is defined **structurally** over
 * {@link EventScope} (which IS in spec) with the `RuntimeContext`-added fields
 * (`opId` / `parentOpId` / `op` / `correlationId` / `traceparent` / `user`)
 * inlined. The shapes are kept in lockstep by construction: a `RuntimeContext`
 * value is structurally assignable to `StoreCtx` (every field `StoreCtx` adds is
 * optional), which is exactly what the runtime relies on when it builds a
 * `StoreCtx` from harness slots (Run A) and, later, enriches it from
 * `getContext` (Run B). If `RuntimeContext` ever moves into spec, this can
 * collapse to a literal `extends`.
 *
 * ## The event-sourcing seam (Run B)
 *
 * `journalReader` + `asOf` are the read-side seam a **derived / event-sourced**
 * store folds over: `journalReader` exposes the READ slice of the
 * `OperationJournal` ({@link JournalReader} — query-shaped historical reads
 * only, no append/tail), and `asOf` pins the fold's upper bound. Run A only
 * populates `journalReader` (from the harness's `this.journal`); the reference
 * event-sourced store that consumes it ships in Run B. `opId` is the idempotency
 * key a durable store dedups on — also wired in Run B.
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-D, §E13
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
 */

import type { Stream } from "effect";

import type { EventScope, EventQuery, ProtocolEvent } from "../data/events.js";
import type { JournalError } from "../data/errors.js";
import type { JournalReadFrom } from "./journal.js";

/**
 * The READ slice of {@link import("./journal.js").OperationJournal} — the ONLY
 * journal surface a **derived / event-sourced store** needs. A derived store
 * folds historical events into its projection; it does NOT append (writes go
 * through the normal command path) and does NOT tail (a store read is a
 * point-in-time fold, not a live subscription). Narrowing to this slice keeps a
 * store from reaching the append/tail/idempotency surface it has no business
 * touching.
 *
 * `OperationJournal` is structurally assignable to this interface — its
 * `readByQuery` has the identical signature — so a harness passes `this.journal`
 * as the `journalReader` with no adapter.
 */
export interface JournalReader {
  /**
   * Read events matching a query starting from a given cursor position.
   * Returns a `Stream` that terminates when the journal has no more matching
   * events at read time. The fold input for a derived store.
   */
  readByQuery(
    query: EventQuery,
    from: JournalReadFrom,
  ): Stream.Stream<ProtocolEvent, JournalError, never>;
}

/**
 * Empty-seed augmentation slot for store-ctx-specific ambient fields, mirroring
 * `RuntimeContextUser` / {@link EventScopeExtensions}. A store package that needs
 * to thread its own value across the Effect→Promise boundary augments via module
 * declaration:
 *
 * @example
 *     declare module "@agentick/spec-next" {
 *       interface StoreCtxExtensions {
 *         readonly tenantShard?: string;
 *       }
 *     }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StoreCtxExtensions {}

/**
 * The explicit runtime-scope carrier threaded into every store DATA method as
 * the FINAL parameter — the store-side twin of `AsyncMiddleware`'s explicit
 * `ctx`. Structurally a `RuntimeContext` (see the import-discipline note above)
 * plus three store-only fields.
 *
 * The runtime fields (`opId` / `parentOpId` / `op` / `correlationId` /
 * `traceparent` / `user`) are inlined from `RuntimeContext` so a `RuntimeContext`
 * value is assignable here. Every field is optional — outside an active op scope
 * they are `undefined`.
 *
 *   - `opId` — the operation id. The **idempotency key** a durable store dedups
 *     writes on (Run B wires the dedup; Run A only carries it).
 *   - `journalReader` / `asOf` — the **event-sourcing read seam** (Run B). A
 *     derived store folds `journalReader.readByQuery(...)` up to `asOf`; an
 *     in-memory store ignores both.
 *   - `signal` — an optional `AbortSignal` a long-running durable read/write can
 *     honor. In-memory stores ignore it.
 *
 * Pure in-memory stores (the bundled defaults) **accept and ignore** `ctx` —
 * they hold no durable state that identity/idempotency/as-of would change.
 */
export interface StoreCtx extends EventScope, StoreCtxExtensions {
  // ── Inlined from RuntimeContext (spec cannot import runtime; see note) ──
  readonly opId?: string;
  readonly parentOpId?: string;
  readonly op?: string;
  readonly correlationId?: string;
  readonly traceparent?: string;
  /**
   * Adopter ambient state. Typed `unknown` here because its concrete shape
   * (`RuntimeContextUser`) is declared in `@agentick/runtime-next`, which spec
   * cannot import. A `RuntimeContext.user` value assigns cleanly.
   */
  readonly user?: unknown;

  // ── Store-only fields ──────────────────────────────────────────────────
  /** The READ slice of the harness's journal — the event-sourcing fold input. */
  readonly journalReader?: JournalReader;
  /** Optional abort signal a durable store may honor. */
  readonly signal?: AbortSignal;
  /** Upper bound for an event-sourced store's fold (Run B). */
  readonly asOf?: JournalReadFrom;
}
