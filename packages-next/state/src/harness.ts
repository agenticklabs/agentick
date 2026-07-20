/**
 * StateHarness — session-internal reactive K/V storage.
 *
 * Implements {@link StateHarnessProtocol}. Extends `BaseHarness<"state">`
 * so writes participate in the substrate's Operation contract
 * (requested → terminal envelopes, lifecycle handlers, middleware,
 * idempotency replay, journaling).
 *
 *   Sync surface   — get / has / list / subscribe / subscribeAll.
 *                     Reads the sync {@link ReactiveView} (the store's read
 *                     cache); no envelopes.
 *   Async surface  — set / delete. Declared commands (ADR 51): each
 *                     runs through `runOperation` with canonical
 *                     naming; the terminal envelope IS the change-event
 *                     audit; the same verbs are inbox-addressable over
 *                     `state:{scopeId}` (`"state:set"` / `"state:delete"`)
 *                     with zero routing code.
 *
 * Snapshot/restore — `exportSnapshot()` / `importSnapshot()` round-trip
 * the entries. Used by SnapshotHarness for hibernate/resume.
 *
 * Storification (data-layer plan §3.5) — the near-identical twin of knobs.
 * State is store-derived AND store-persisted: a durable {@link ReactiveStore}
 * of `{ key, value }` cells is the authority, and a synchronous
 * {@link ReactiveView} is its read cache (reads never touch the async store).
 * Every value mutation writes through the view (sync cache first, durable store
 * off the critical path via the `query`/`mutate` seam) AND, in the same call,
 * pings render subscribers and emits the typed change — the sync-cache,
 * write-through, render-ping, and delta-stream machinery all live in the ONE
 * `ReactiveView` (they were three hand-rolled fields). `hydrate()` reloads the
 * store into the view on resume. State has no client-facing channel, so nothing
 * projects the change stream to the wire today (see the `state-deltas` TODO).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  CollectionMutation,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ReactiveStore,
  StateDeleteInput,
  StateHarnessProtocol,
  StateSetInput,
  StoreCtx,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";
import { type ChangeEvent } from "@agentick/pubsub-next";
import { ReactiveView } from "@agentick/store-next";
import { createStateStore, type StateEntry, type StateStoreQuery } from "./store.js";

/**
 * Construction options for {@link StateHarness}. Minimal — state takes its
 * substrate positionally; this carries only the durable store override.
 */
export interface StateHarnessOptions {
  /**
   * Durable backing for state VALUES (data-layer plan §3.5, Phase 3). Defaults
   * to a fresh per-harness in-memory {@link createStateStore}. The store holds
   * `{ key, value }` cells; it is the durable truth, the synchronous
   * {@link ReactiveView} is its sync read cache (reads never touch the store).
   * Injecting a durable adapter (Postgres, …) is how state survives process
   * restart; `hydrate()` loads it back into the view. Typed against the
   * `ReactiveStore` SEAM — a durable adapter need only implement `query`/`mutate`.
   */
  readonly store?: ReactiveStore<StateEntry, StateStoreQuery, CollectionMutation<StateEntry>>;
}

export class StateHarness extends BaseHarness<"state"> implements StateHarnessProtocol {
  /**
   * The synchronous {@link ReactiveView} of the value store — ONE primitive that
   * collapses the three fields this used to hand-roll (a `CollectionProjection`
   * for the sync cache + write-through, a `KeyedNotifier` for render pings, a
   * `ChangeNotifier` for the typed delta stream). `get` / `has` / `list` /
   * `subscribe` read it (sync, never async-through-the-store); `applySet` /
   * `applyDelete` write through it (sync cache first, durable `{ key, value }`
   * store off the critical path via the `query`/`mutate` seam) and each single
   * write pings the key AND emits the typed change. Add-vs-update rides the
   * view's cache PRESENCE (`hasSync`), NOT `prev !== undefined` — state may
   * legitimately store `undefined`.
   */
  private readonly view: ReactiveView<StateEntry, StateStoreQuery, CollectionMutation<StateEntry>>;

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns construction, routing, and enumeration.
   */
  readonly set: (input: StateSetInput) => Promise<void>;
  readonly delete: (input: StateDeleteInput) => Promise<void>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: StateHarnessOptions = {},
  ) {
    super("state", scopeId, journal, bus, inbox);
    this.view = ReactiveView.collection(options.store ?? createStateStore(), (entry) => entry.key);
    const scope = () => ({ sessionId: this.scopeId });
    this.set = this.command({
      name: "state:set",
      scope,
      // Run B: read the ENRICHED store-ctx inside the fiber (carries the live
      // op's `opId`) and thread it to the mutation.
      handler: (i: StateSetInput) =>
        Effect.gen(this, function* () {
          this.applySet(i, yield* this.storeCtxEffect());
        }),
    });
    this.delete = this.command({
      name: "state:delete",
      scope,
      handler: (i: StateDeleteInput) =>
        Effect.gen(this, function* () {
          this.applyDelete(i, yield* this.storeCtxEffect());
        }),
    });
  }

  // ─────────── Sync surface ───────────

  get(key: string): unknown {
    // Mirrors `Map.get`: a stored `{ key, value: undefined }` and an absent key
    // both read back as `undefined`. Callers that must distinguish use `has`
    // (backed by `hasSync`, a key-membership check independent of the value).
    return this.view.getSync(key)?.value;
  }

  has(key: string): boolean {
    return this.view.hasSync(key);
  }

  list(): readonly string[] {
    return this.view.listSync().map((entry) => entry.key);
  }

  subscribe(key: string, listener: () => void): Unsubscribe {
    return this.view.subscribe(key, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.view.subscribeAll(listener);
  }

  /**
   * Subscribe to the typed change stream (ADR 75 notify seam). Each set /
   * delete emits a `ChangeEvent` (`{ key, value?, prev? }`) carrying the
   * delta — set → add/update, delete → remove. Read-only and
   * fire-and-forget; the push twin of the bare `subscribe` render-ping.
   *
   * TODO(notify-seam): promote to `StateHarnessProtocol` when a
   * protocol-typed (cross-package) projection needs it — class-only until a
   * consumer exists.
   */
  onChange(listener: (change: ChangeEvent<unknown>) => void): Unsubscribe {
    // The view's change stream is ENTRY-typed (`{ key, value }`); the public
    // notify seam is VALUE-typed. Project entry → value, preserving key-presence
    // (`"value"`/`"prev" in c`) so add/update/remove classify identically —
    // critically for `undefined` values, which key-presence handles but a
    // `!== undefined` check would misread.
    return this.view.onChange((c) => listener(toValueChange(c, (e) => e.value)));
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const { key, value } of this.view.listSync()) out[key] = value;
    return out;
  }

  importSnapshot(values: Readonly<Record<string, unknown>>): void {
    // Wholesale replace via the view: keys absent from `values` are dropped from
    // BOTH the cache and the store; the snapshot's cells write through. The view
    // updates the whole cache FIRST then batch-pings the union (drops ∪ upserts),
    // and is change-SILENT (state has no channel, so no per-key deltas anyway).
    //
    // TODO(store-phase-4): `importSnapshot` is the ACTIVE snapshot-based resume
    // path. The Phase-4 manifest sweep replaces it with `hydrate()` once the
    // store is the authority. Do NOT wire `hydrate()` into resume while this
    // method still owns it.
    const entries: StateEntry[] = Object.entries(values).map(([key, value]) => ({ key, value }));
    this.view.replace(entries, this.storeCtx());
  }

  /**
   * Load the durable value store into the sync projection — the future manifest
   * resume path (data-layer plan Phase 4 / BaseHarness §2.3). The projection
   * owns the store→cache merge and returns the keys it loaded; the harness owns
   * notification (the primitive is a write sink, not a notifier). Pings each
   * hydrated key so both per-key and wildcard subscribers re-read. This is a
   * MERGE (store cells overlay the projection), not a clear-first replace — a
   * fresh session's store is empty ⇒ a no-op.
   *
   * NOT wired into session resume in this run: `importSnapshot` remains the
   * active resume path. `hydrate()` is the seam the Phase-4 manifest sweep flips
   * to once the store is authority.
   */
  async hydrate(): Promise<void> {
    // The view merges the store projection into the cache and pings each loaded
    // key (a MERGE, not clear-first — a fresh store is empty ⇒ a no-op).
    // Change-silent.
    await this.view.hydrate(undefined, this.storeCtx());
  }

  // ─────────── Inbox routing ───────────

  /**
   * `state:set` / `state:delete` are declared commands — routed by the
   * BaseHarness command registry before this fallthrough. Only unknown
   * types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown state message type: ${msg.type}` }));
  }

  // ─────────── Internals ───────────

  private applySet(input: StateSetInput, ctx: StoreCtx = this.storeCtx()): void {
    // One write through the view: sync cache first (reads reflect it now),
    // durable store off the critical path via the seam, a render ping, and the
    // typed change — the whole trio (dual-write + fireListeners + emitChange)
    // collapsed. Add-vs-update rides the view's cache PRESENCE (`hasSync`), NOT
    // `prev !== undefined`, so a `set(key, undefined)` on a NEW key classifies
    // as an add and on an EXISTING key as an update. `ctx` is the enriched
    // store-ctx the command handler read inside the fiber.
    this.view.write({ key: input.key, value: input.value }, ctx);
  }

  private applyDelete(input: StateDeleteInput, ctx: StoreCtx = this.storeCtx()): void {
    // Idempotent inside the view: a no-op delete of an absent key fires nothing
    // and emits no change; a real removal pings + emits `{ key, prev }`.
    this.view.deleteSync(input.key, ctx);
  }

  // TODO(state-deltas): project a `state` snapshot+delta channel like
  // KnobsHarness does (packages-next/knobs/src/channel.ts, ADR 73) — as a
  // SUBSCRIBER of `this.view.onChange`, exactly as knobs' `projectStateDelta`
  // now does: `changeKind(change)` → add/replace/remove op, `importSnapshot`
  // → a full snapshot frame; consumers apply with `applyJsonPatch`. The view's
  // stream is ENTRY-typed (`{ key, value }`), so a `set(key, undefined)` carries
  // a present entry (add/update classifies correctly) — the far-side wire codec
  // must still encode the unwrapped `undefined` value explicitly (JSON `null` or
  // a presence flag) so the key is not dropped on apply. A shared "SnapshotCapable
  // reactive harness projects snapshot+deltas from its change stream" mixin would
  // DRY knobs + state.
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Project an ENTRY-typed change (the view's `{ key, value }` stream) onto a
 * VALUE-typed one (the public notify seam), preserving KEY-PRESENCE so
 * add/update/remove classify identically — `"value" in c` / `"prev" in c`, NOT
 * `!== undefined`, which is load-bearing for state's legitimately-`undefined`
 * values.
 */
function toValueChange<T, V>(c: ChangeEvent<T>, valueOf: (t: T) => V): ChangeEvent<V> {
  const out: { key: string; value?: V; prev?: V } = { key: c.key };
  if ("value" in c) out.value = valueOf(c.value as T);
  if ("prev" in c) out.prev = valueOf(c.prev as T);
  return out;
}
