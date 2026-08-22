/**
 * StateHarness — session-internal reactive K/V storage.
 *
 * Implements {@link StateHarnessProtocol}. Extends `BaseHarness<"state">`
 * so writes participate in the substrate's Operation contract
 * (requested → terminal envelopes, lifecycle handlers, middleware,
 * idempotency replay, journaling).
 *
 *   Sync surface   — get / has / list / subscribe / subscribeAll.
 *                     Reads the sync {@link View} (the store's read
 *                     cache); no envelopes.
 *   Async surface  — set / delete. Declared commands (ADR 51): each
 *                     runs through `runOperation` with canonical
 *                     naming; the terminal envelope IS the change-event
 *                     audit; the same verbs are inbox-addressable over
 *                     `state:{scopeId}` (`"state:set"` / `"state:delete"`)
 *                     with zero routing code.
 *
 * Checkpoint — `persist()` flushes write-behind to the store, `hydrate()`
 * rebuilds the projection from it (checkpointing §3.2). The residual
 * `exportSnapshot()` / `importSnapshot()` pair no longer runs on resume: the
 * session fold gives CheckpointCapable precedence. `branch()` copies another
 * session's partition onto this one — the fork transport (checkpointing §5).
 *
 * Storification (data-layer plan §3.5) — the near-identical twin of knobs.
 * State is store-derived AND store-persisted: a durable {@link StateStore}
 * of `{ scope, key, value }` cells is the authority, and a synchronous
 * {@link View} is its read cache (reads never touch the async store).
 * Every value mutation writes through the view (sync cache first, durable store
 * off the critical path via the `query`/`mutate` seam) AND, in the same call,
 * pings render subscribers and emits the typed change — the sync-cache,
 * write-through, render-ping, and delta-stream machinery all live in the ONE
 * `View` (they were three hand-rolled fields). State has no client-facing
 * channel, so nothing projects the change stream to the wire today (see the
 * `state-deltas` TODO).
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { Effect } from "effect";
import { BaseHarness, type BaseHarnessOptions, type Unsubscribe } from "@agentick/runtime";
import type {
  BranchCapable,
  BranchCtx,
  CheckpointCapable,
  CollectionMutation,
  EventBus,
  HydrateCtx,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  PersistCtx,
  StateDeleteInput,
  StateHarnessProtocol,
  StateListEntry,
  StateFx,
  StateSetInput,
  StoreCtx,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";
import { type ChangeEvent } from "@agentick/pubsub";
import { View } from "@agentick/store";
import {
  createStateStore,
  stateScope,
  stateStoreKey,
  type StateEntry,
  type StateStore,
  type StateStoreQuery,
} from "./store.js";

/**
 * Construction options for {@link StateHarness}. Minimal — state takes its
 * substrate positionally; this carries only the durable store override.
 */
export interface StateHarnessOptions extends BaseHarnessOptions<unknown, "state"> {
  /**
   * Durable backing for state VALUES (data-layer plan §3.5, Phase 3). Defaults
   * to a fresh per-harness in-memory {@link createStateStore}. It is the durable
   * truth, the synchronous {@link View} is its sync read cache (reads never
   * touch the store). Injecting a durable adapter (Postgres, …) is how state
   * survives process restart; {@link StateHarness.hydrate} loads it back into
   * the view.
   *
   * An injected store is expected to OUTLIVE the harness — durability across
   * instances is the whole point — so it is shared by every session the app
   * runs. Cells carry their owning `scope` and reads select on it.
   */
  readonly store?: StateStore;
}

export class StateHarness
  extends BaseHarness<"state">
  implements StateHarnessProtocol, CheckpointCapable, BranchCapable
{
  /** The durable truth. Held alongside {@link view} because {@link branch} copies at the store layer. */
  private readonly store: StateStore;

  /**
   * The synchronous {@link View} of the value store — ONE primitive that
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
  private readonly view: View<
    StateListEntry,
    StateEntry,
    StateStoreQuery,
    CollectionMutation<StateEntry>
  >;

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns construction, routing, and enumeration.
   */
  readonly set: (input: StateSetInput) => Promise<void>;
  readonly delete: (input: StateDeleteInput) => Promise<void>;

  /**
   * The Effect-canonical twin (ADR 77). An in-process caller composes
   * `yield* state.fx.set(...)` and stays in ONE fiber tree, so the resulting
   * op keeps the ambient `tickId` / `parentOpId`; the plain `state.set(...)`
   * Promise methods are the derived edge facade. Both dispatch the SAME
   * declared command — `fxProxy` derives `fx.<action>` from the
   * `<surface>:<action>` naming convention, so there is no map to maintain.
   */
  get fx(): StateFx {
    return this.fxProxy() as unknown as StateFx;
  }

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
    // ADR 93 landmine 11 — the interceptor fold reaches this harness's commands
    // (`state:set`, …) so `app.guard()` / `createApp({ hooks, guards })` wrap
    // them. State used to construct `super` with no options at all.
    super("state", scopeId, journal, bus, inbox, options);
    this.store = options.store ?? createStateStore();
    this.view = new View({
      store: this.store,
      keyOf: (cell) => cell.key,
      project: (cell) => ({ scope: scopeId, key: cell.key, value: cell.value }),
      reconstruct: (entry) => ({ key: entry.key, value: entry.value }),
      toPut: (entry) => ({ put: entry }),
      toDelete: (key) => ({ delete: stateStoreKey(scopeId, key) }),
    });
    // NO scope factory. The owning session is gap-filled by `makeEvent` from the
    // harness's construction-bound `parentScope` (BaseHarness), so a command that
    // adds no dims of its own declares nothing. Every command here previously
    // carried `() => ({ sessionId: this.scopeId })` — the COMPOSED key
    // `<sessionId>:<surface>`, which no session-scoped subscription can match.
    this.set = this.command({
      name: "state:set",
      // Wire-reachable (three-audiences-plan G): a client `session.state` handle
      // mutates through the dynamic lane, deny-by-default like every sibling.
      exposure: "wire",
      // Run B: read the ENRICHED store-ctx inside the fiber (carries the live
      // op's `opId`) and thread it to the mutation.
      handler: (i: StateSetInput) =>
        Effect.gen(this, function* () {
          this.applySet(i, yield* this.storeCtxEffect());
        }),
    });
    this.delete = this.command({
      name: "state:delete",
      exposure: "wire",
      handler: (i: StateDeleteInput) =>
        Effect.gen(this, function* () {
          this.applyDelete(i, yield* this.storeCtxEffect());
        }),
    });

    // ─── Wire read commands (three-audiences-plan G-prep) — the read lane a
    // client `session.state` handle needs (state had NO read command). Registered
    // for their side effect (wire-reachability + `commands/list` enumeration);
    // the SYNC `get`/`list` serve in-process reads, so the callables are
    // discarded. `state:get` returns the raw value (undefined ⇒ absent-or-unset,
    // same conflation as `get`); `state:list` returns `{ key, value }` entries.
    this.command({
      name: "state:get",
      exposure: "wire",
      handler: (i: { key: string }) => Effect.sync(() => this.get(i.key)),
    });
    this.command({
      name: "state:list",
      exposure: "wire",
      handler: () => Effect.sync(() => this.list()),
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

  list(): readonly StateListEntry[] {
    // Entries (`{ key, value }`), the sibling projection depth — the store cell
    // IS a `{ key, value }` record, so the sync view list is already the shape.
    return this.view.listSync();
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
    // TODO(checkpoint-sweep): superseded by `hydrate()` — the session fold gives
    // CheckpointCapable precedence, so this no longer runs on resume. It dies
    // with `SnapshotCapable` in the Phase-4 sweep (checkpointing §5); the one
    // live caller left is `withState({ initial })`.
    const entries: StateListEntry[] = Object.entries(values).map(([key, value]) => ({
      key,
      value,
    }));
    this.view.replace(entries, this.storeCtx());
  }

  // ─────────── Checkpoint (CheckpointCapable) ───────────

  /**
   * The durability barrier: writes go through eagerly and off the critical
   * path, so this awaits the ones still in flight and rethrows the first that
   * failed — which is what aborts the caller's unmount (checkpointing §3.2).
   */
  async persist(_ctx: PersistCtx): Promise<void> {
    await this.view.flush();
  }

  /**
   * Rebuild the sync projection from this harness's partition of the store.
   * Pings every touched key and emits no typed change — `importSnapshot`'s
   * notification behavior exactly.
   *
   * The partition key is this harness's own `scopeId`, NOT
   * `ctx.storeCtx.sessionId`, which on this path carries the SESSION harness's
   * scope id.
   */
  async hydrate(ctx: HydrateCtx): Promise<void> {
    await this.view.hydrate({ scope: this.scopeId }, ctx.storeCtx, { replace: true });
  }

  /**
   * Copy the source session's cells onto this harness's own partition — the
   * fork transport (checkpointing §5). Store-layer only: the projection is left
   * alone because the fork path always follows `branch` with a `hydrate`.
   *
   * Idempotent by a non-empty own partition, so a retried fork does not
   * overwrite a child that has since diverged.
   */
  async branch(ctx: BranchCtx): Promise<void> {
    const mine = await this.store.query({ scope: this.scopeId }, ctx.storeCtx);
    if (mine.length > 0) return;
    const source = await this.store.query({ scope: stateScope(ctx.fromSessionId) }, ctx.storeCtx);
    for (const entry of source) {
      await this.store.mutate({ put: { ...entry, scope: this.scopeId } }, ctx.storeCtx);
    }
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
  // KnobsHarness does (packages/knobs/src/channel.ts, ADR 73) — as a
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
