/**
 * StateHarness — session-internal reactive K/V storage.
 *
 * Implements {@link StateHarnessProtocol}. Extends `BaseHarness<"state">`
 * so writes participate in the substrate's Operation contract
 * (requested → terminal envelopes, lifecycle handlers, middleware,
 * idempotency replay, journaling).
 *
 *   Sync surface   — get / has / list / subscribe / subscribeAll.
 *                     Reads the sync {@link CollectionProjection} (the store's
 *                     read cache); no envelopes.
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
 * State is store-derived AND store-persisted: a durable {@link CollectionStore}
 * of `{ key, value }` cells is the authority, and a synchronous
 * {@link CollectionProjection} is its read cache (reads never touch the async
 * store). Every value mutation dual-writes through the projection (sync cache
 * first, durable store off the critical path); `hydrate()` reloads the store
 * into the projection on resume. The projection is a WRITE SINK beside the
 * `notifier` / `changes` reactive seam, NEVER a source of it — every mutation
 * writes it AND drives the seam by hand, exactly as before. State has no
 * client-facing channel, so no projection routes through the store.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  CollectionStore,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  StateDeleteInput,
  StateHarnessProtocol,
  StateSetInput,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";
import {
  createChangeNotifier,
  createKeyedNotifier,
  type ChangeEvent,
  type ChangeNotifier,
  type KeyedNotifier,
} from "@agentick/pubsub-next";
import { CollectionProjection } from "@agentick/store-next";
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
   * {@link CollectionProjection} is its sync read cache (reads never touch the
   * store). Injecting a durable adapter (Postgres, …) is how state survives
   * process restart; `hydrate()` loads it back into the projection.
   */
  readonly store?: CollectionStore<StateEntry, StateStoreQuery>;
}

export class StateHarness extends BaseHarness<"state"> implements StateHarnessProtocol {
  /**
   * The synchronous read PROJECTION of the value store (data-layer plan §3.5
   * P5) — `get` / `has` / `list` / `subscribe` read it, so state reads stay
   * sync (never async-through-the-store). The shared {@link CollectionProjection}
   * owns the dual-write (sync cache first, durable {@link StateEntry} store off
   * the critical path) and the {@link CollectionProjection.hydrate} merge. It is
   * a WRITE SINK beside the `notifier` / `changes` seam, never a source: every
   * mutation writes it AND drives the seam by hand, exactly as before.
   */
  private readonly projection: CollectionProjection<StateEntry, StateStoreQuery>;
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  /**
   * The notify seam (ADR 75): typed push carrying the delta. Distinct from
   * `notifier` (bare render pings) — mutation sites emit a semantic
   * `ChangeEvent` here; projections (a future `state` snapshot+delta channel,
   * timeline events) subscribe via {@link onChange}. Values are `unknown`, so
   * add-vs-update is decided by an `existed` (`has`) check, NOT
   * `prev !== undefined` — state may legitimately store `undefined`.
   */
  private readonly changes: ChangeNotifier<unknown> = createChangeNotifier<unknown>();

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
    this.projection = new CollectionProjection<StateEntry, StateStoreQuery>(
      options.store ?? createStateStore(),
      (entry) => entry.key,
    );
    const scope = () => ({ sessionId: this.scopeId });
    this.set = this.command({
      name: "state:set",
      scope,
      handler: (i: StateSetInput) => Effect.sync(() => this.applySet(i)),
    });
    this.delete = this.command({
      name: "state:delete",
      scope,
      handler: (i: StateDeleteInput) => Effect.sync(() => this.applyDelete(i)),
    });
  }

  // ─────────── Sync surface ───────────

  get(key: string): unknown {
    // Mirrors `Map.get`: a stored `{ key, value: undefined }` and an absent key
    // both read back as `undefined`. Callers that must distinguish use `has`
    // (backed by `hasSync`, a key-membership check independent of the value).
    return this.projection.getSync(key)?.value;
  }

  has(key: string): boolean {
    return this.projection.hasSync(key);
  }

  list(): readonly string[] {
    return this.projection.listSync().map((entry) => entry.key);
  }

  subscribe(key: string, listener: () => void): Unsubscribe {
    return this.notifier.subscribe(key, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.notifier.subscribeAll(listener);
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
    return this.changes.onChange(listener);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const { key, value } of this.projection.listSync()) out[key] = value;
    return out;
  }

  importSnapshot(values: Readonly<Record<string, unknown>>): void {
    const oldKeys = new Set(this.projection.listSync().map((entry) => entry.key));
    const newKeys = new Set(Object.keys(values));
    const changed = new Set<string>([...oldKeys, ...newKeys]);
    // Wholesale replace: a key present before but absent from `values` is
    // dropped from BOTH the projection cache and the store (delete-not-present),
    // then the snapshot's cells dual-write through the projection. In every real
    // call path (seed, restore) the harness is fresh so the drop loop is a
    // no-op; the loop makes a theoretical re-import onto a populated harness an
    // honest replace rather than an upsert that would leave the store to
    // resurface stale keys via `hydrate()`.
    //
    // TODO(store-phase-4): `importSnapshot` is the ACTIVE snapshot-based resume
    // path. The Phase-4 manifest sweep replaces it with `hydrate()` once the
    // store is the authority (and picks up the durable-write flush barrier now
    // centralized in `CollectionProjection.write`). Do NOT wire `hydrate()`
    // into resume while this method still owns it.
    for (const k of oldKeys) if (!newKeys.has(k)) this.projection.deleteSync(k);
    for (const [k, v] of Object.entries(values)) this.projection.write({ key: k, value: v });
    for (const key of changed) this.fireListeners(key);
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
    const keys = await this.projection.hydrate();
    for (const k of keys) this.fireListeners(k);
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

  private applySet(input: StateSetInput): void {
    // `existed`, not `prev !== undefined`: state may store `undefined` as a
    // real value, so a `hasSync` check is the exact add-vs-update discriminator.
    const existed = this.projection.hasSync(input.key);
    const prev = this.projection.getSync(input.key)?.value;
    // Dual-write through the projection: sync cache first (reads reflect it
    // now), durable store off the critical path. The notify seam below
    // (`fireListeners` + `changes`) is driven by hand, exactly as before — the
    // projection is a write sink beside it, never a source.
    this.projection.write({ key: input.key, value: input.value });
    this.fireListeners(input.key);
    this.changes.emitChange(
      existed
        ? { key: input.key, value: input.value, prev }
        : { key: input.key, value: input.value },
    );
  }

  private applyDelete(input: StateDeleteInput): void {
    if (!this.projection.hasSync(input.key)) return;
    const prev = this.projection.getSync(input.key)?.value;
    this.projection.deleteSync(input.key);
    this.fireListeners(input.key);
    // Remove — value omitted. `changeKind` reads this as "remove" regardless
    // of whether the stored value was itself `undefined`.
    this.changes.emitChange({ key: input.key, prev });
  }

  private fireListeners(key: string): void {
    this.notifier.notify(key);
  }

  // TODO(state-deltas): project a `state` snapshot+delta channel like
  // KnobsHarness does (packages-next/knobs/src/channel.ts, ADR 73) — but as a
  // SUBSCRIBER of `changes.onChange`, exactly as knobs' `projectStateDelta`
  // now does: `changeKind(change)` → add/replace/remove op, `importSnapshot`
  // → a full snapshot frame; consumers apply with `applyJsonPatch`. One
  // caveat for `unknown` values: a `set(key, undefined)` yields a ChangeEvent
  // whose `value` is absent, which `changeKind` classifies as "remove" — the
  // channel must special-case undefined-valued sets (emit an explicit JSON
  // `null` or a presence flag) so the far side doesn't drop the key. A shared
  // "SnapshotCapable reactive harness projects snapshot+deltas from its
  // change stream" mixin would DRY knobs + state.
}
