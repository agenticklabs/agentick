/**
 * KnobsHarness — model-visible reactive state as a full harness.
 *
 * Implements {@link KnobsHarnessProtocol}. Extends `BaseHarness<"knobs">`
 * so its writes participate in the substrate's full Operation contract
 * (requested → terminal envelopes, lifecycle handlers, middleware,
 * idempotency replay, journaling).
 *
 *   Sync surface     — get / has / list / subscribe / subscribeAll.
 *                       Reads from local Map; no envelopes; cheap.
 *   Async surface    — set / register / dispatch. Each runs through
 *                       `runOperation`; the terminal envelope IS the
 *                       change-event audit trail.
 *
 * Inbox routing — three message types reach the harness over its
 * address (`knobs:{scopeId}`):
 *
 *   - `"knobs:set"`       → invokes {@link set}
 *   - `"knobs:register"`  → invokes {@link register}
 *   - `"knobs:dispatch"`  → invokes {@link dispatch}
 *
 * The cluster case: an admin dashboard on a remote node sends an
 * inbox message addressed to this harness; the cluster substrate
 * routes it; the handler runs the same Operation that an in-process
 * call would.
 *
 * Checkpoint — `persist()` flushes the value store, `hydrate()` rebuilds the
 * projection from it (checkpointing §3.2). Descriptors are never persisted;
 * components re-declare them on remount. The residual `exportSnapshot()` /
 * `importSnapshot()` pair coexists until the Phase-4 sweep.
 *
 * Layer chain (ADR 34 cascade) — the harness optionally resolves over an
 * ordered `[parent, self]` chain: a read-only fallback `parentLayer`
 * shadowed by this (self) layer. Reads (`get` / `has` / `list`) fall
 * through to the parent when self has no entry; self always shadows
 * parent by id. Writes (`set` / `register`) mutate SELF ONLY — the parent
 * is never touched. Critically, `exportSnapshot()` captures the SELF layer
 * ONLY: a session snapshot must not embed inherited (app-scoped) state,
 * which is snapshotted at the parent's own scope. Today the parent is
 * absent everywhere (the session constructs its knobs with
 * `parentLayer` undefined), so the chain is just `[self]` and behavior is
 * byte-identical to a single layer — the seam merely lets a future app
 * tier drop in with no rewrite. (Named `parentLayer` — the parent *knob layer*
 * in a value-resolution cascade — to distinguish it from the harness scope
 * hierarchy that the interceptor/hook construction-fold threads.)
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import { Effect } from "effect";
import {
  BaseHarness,
  type BaseHarnessOptions,
  type Middleware,
  type Unsubscribe,
} from "@agentick/runtime";
import type {
  BranchCapable,
  BranchCtx,
  CheckpointCapable,
  CollectionMutation,
  ContentBlock,
  EventBus,
  HydrateCtx,
  KnobDescriptor,
  KnobPrimitive,
  KnobRegistration,
  KnobValueType,
  KnobsDispatchInput,
  KnobsFx,
  KnobsHarnessProtocol,
  KnobsRegisterInput,
  KnobsSetInput,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  PersistCtx,
  Store,
  StoreCtx,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";
import { changeKind, type ChangeEvent } from "@agentick/pubsub";
import { generateId, type JsonPatchOp } from "@agentick/utils";
import { View } from "@agentick/store";
import type { ChannelSnapshotProvider } from "@agentick/spec";
import {
  KNOBS_STATE_CHANNEL,
  KNOBS_STATE_CHANNEL_FQN,
  knobPointer,
  toWireDescriptor,
  type KnobsStateFrame,
  type KnobsStateSnapshotFrame,
  type WireKnobDescriptor,
} from "./channel.js";
import { createKnobStore, knobsScope, type KnobEntry, type KnobStoreQuery } from "./store.js";

// ============================================================================
// Harness
// ============================================================================

/**
 * Construction options for {@link KnobsHarness}. Minimal today — knobs takes its
 * substrate + layer-chain parent positionally; this carries the ADR 82 resolved
 * hook layer forwarded by the SessionHarness (via `buildSessionBridges`).
 */
/**
 * `extends BaseHarnessOptions` so every slot the base accepts — `parentScope`,
 * `principal`, telemetry, metadata, the interceptor fold — arrives without being
 * re-declared here and re-forwarded by hand. Standing alone, this interface silently
 * dropped every base option a caller passed, and the next thing the base gains would
 * be dropped the same way.
 */
export interface KnobsHarnessOptions extends BaseHarnessOptions<unknown, "knobs"> {
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * session's resolved interceptors (guards, `.use` transforms, AND declarative
   * command hooks adapted to op-scoped middleware), folded in at construction
   * and forwarded to {@link BaseHarness} so `session.use()` / `app.use()` and the
   * app/session `hooks` config all wrap `knobs:set`. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the SessionHarness, so a LATER
   * `session.use()` / `session.guard()` / `session.hook()` (or an app one that
   * folded into the session) reaches this per-session bridge too. Forwarded to
   * {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
  /**
   * Durable backing for knob VALUES (data-layer plan §3.5, Phase 3). Defaults
   * to a fresh per-harness in-memory {@link createKnobStore}. The store holds
   * `{ scope, id, value }` cells only — descriptors are tree-derived and never
   * stored. It is the durable truth; the synchronous {@link View} is its sync
   * read cache (reads never touch the store). Typed against the `Store` SEAM —
   * a durable adapter need only implement `query`/`mutate`.
   *
   * The store must OUTLIVE the harness for values to survive an evict/resume
   * cycle: the checkpoint contract carries no value across the seam, so a
   * per-harness default store means `hydrate()` finds nothing. Cells are keyed
   * by harness scope, so ONE injected app-scoped store serves every session.
   */
  readonly store?: Store<KnobEntry, KnobStoreQuery, CollectionMutation<KnobEntry>>;
}

export class KnobsHarness
  extends BaseHarness<"knobs">
  implements KnobsHarnessProtocol, ChannelSnapshotProvider, CheckpointCapable, BranchCapable
{
  /** The durable truth. Held alongside {@link view} because {@link branch} copies at the store layer. */
  private readonly store: Store<KnobEntry, KnobStoreQuery, CollectionMutation<KnobEntry>>;

  /**
   * The synchronous {@link View} of the value store — ONE primitive that
   * collapses the three fields this used to hand-roll (a `CollectionProjection`
   * for the sync cache + write-through, a `KeyedNotifier` for render pings, a
   * `ChangeNotifier` for the typed StateDelta stream). `get` / `has` / `list` /
   * `subscribe` read it during render (sync, never async-through-the-store);
   * `applySet` / `applyRegister` write through it (sync cache first, durable
   * `{ id, value }` store off the critical path via the `query`/`mutate` seam),
   * and each single write pings the id AND emits the typed change the
   * constructor-wired StateDelta channel projects. The store holds value cells
   * only — descriptors are tree-derived and merged over them at read time.
   */
  private readonly view: View<KnobEntry, KnobEntry, KnobStoreQuery, CollectionMutation<KnobEntry>>;
  private readonly descriptors = new Map<string, KnobRegistration>();

  /**
   * Optional read-only fallback LAYER (ADR 34 cascade). Reads fall
   * through here when self has no entry; self shadows it by id. Never
   * mutated — writes hit SELF only. Absent today ⇒ single-layer behavior
   * (see class doc).
   *
   * This is the parent *knob layer* in a value-resolution cascade — distinct
   * from the harness scope hierarchy (whose interceptor/hook inheritance is a
   * construction-fold), hence the disambiguating name.
   */
  private readonly parentLayer?: KnobsHarnessProtocol;

  /**
   * Cached snapshot for `list()`. Invalidated on every mutation so that
   * `useSyncExternalStore` consumers see stable references between
   * mutations (and a fresh reference after one).
   */
  private listCache: readonly KnobDescriptor[] | null = null;

  /**
   * Monotonic frame counter for the `knobs-state` channel (ADR 73). Every
   * emitted snapshot/delta frame carries the incremented value so a
   * subscriber can detect a dropped frame and re-seed from a snapshot.
   */
  private stateVersion = 0;

  get id(): string {
    return this.scopeId;
  }

  /**
   * Declared commands (ADR 51) — pure layer logic in the handlers; the
   * registry owns construction, inbox routing, and enumeration.
   * `set`'s body is the mutation: lifecycle handlers fire first
   * (`before` can veto), middleware wraps, the terminal envelope
   * publishes after — by resolution the value is set, listeners have
   * fired, and the audit envelope is on the bus + journal.
   * `dispatch` keeps v1 knob_set semantics: the Operation succeeds
   * either way; the result blocks distinguish validation failure from
   * successful mutation.
   */
  readonly set: (input: KnobsSetInput) => Promise<void>;
  readonly register: (input: KnobsRegisterInput) => Promise<void>;
  readonly dispatch: (input: KnobsDispatchInput) => Promise<readonly ContentBlock[]>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    parentLayer?: KnobsHarnessProtocol,
    options: KnobsHarnessOptions = {},
  ) {
    // Forward the WHOLE bag: nothing to enumerate, so nothing to forget. Every
    // hand-picked `super({ inheritedInterceptors, interceptorParent })` was a place a
    // new base option would silently vanish — and `parentScope` did exactly that.
    super("knobs", scopeId, journal, bus, inbox, options);
    this.parentLayer = parentLayer;
    this.store = options.store ?? createKnobStore();
    this.view = View.collection(this.store, (entry) => entry.id);
    // NO scope factory. The owning session is folded into the resolved op scope from
    // the harness's construction-bound `parentScope` (BaseHarness), so a command that
    // adds no dims of its own declares nothing. Every command here previously carried
    // `() => ({ sessionId: this.scopeId })` — the COMPOSED key `<sessionId>:knobs`,
    // which no session-scoped subscription can match.
    this.set = this.command({
      name: "knobs:set",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      // Run B: read the ENRICHED store-ctx inside the fiber (carries the live
      // op's `opId` etc.) and thread it to the mutation, instead of the helper
      // synthesizing a construction-only base ctx.
      handler: (i: KnobsSetInput) =>
        Effect.gen(this, function* () {
          this.applySet(i, yield* this.storeCtxEffect());
        }),
    });
    this.register = this.command({
      name: "knobs:register",
      handler: (i: KnobsRegisterInput) =>
        Effect.gen(this, function* () {
          this.applyRegister(i, yield* this.storeCtxEffect());
        }),
    });
    this.dispatch = this.command({
      name: "knobs:dispatch",
      handler: (i: KnobsDispatchInput) =>
        Effect.gen(this, function* () {
          return this.executeDispatch(i, yield* this.storeCtxEffect());
        }),
    });
    // Wire the StateDelta (ADR 73) projection onto the view's change stream:
    // each single write emits a semantic ChangeEvent; this projection derives
    // the JSON-Patch op. Decoupled so additional projections attach to the same
    // stream without touching the mutation logic. (Bulk paths — importSnapshot's
    // replace — are change-silent; the harness emits its own snapshot frame.)
    this.view.onChange((change) => this.projectStateDelta(change));
  }

  /**
   * The Effect-canonical async surface (ADR 77, the dual-typed edge) —
   * the composable Effect twins of `set` / `register` / `dispatch`. An
   * in-process caller reaches these to compose a knobs write into a
   * larger Effect (`yield* knobs.fx.set(...)`) and stay in one fiber
   * tree; the plain `knobs.set(...)` Promise methods are the derived
   * edge facade (`runPromise` at the boundary). Both dispatch the SAME
   * declared command — `fx` is the sugar over `commandEffect`, typed via
   * {@link KnobsFx}.
   */
  get fx(): KnobsFx {
    return this.fxProxy() as unknown as KnobsFx;
  }

  // ─────────── Sync surface ───────────

  get(id: string): KnobPrimitive | undefined {
    // Self shadows parent; fall through only when self has no cell.
    return this.view.hasSync(id) ? this.view.getSync(id)?.value : this.parentLayer?.get(id);
  }

  has(id: string): boolean {
    return this.view.hasSync(id) || (this.parentLayer?.has(id) ?? false);
  }

  list(): readonly KnobDescriptor[] {
    if (this.listCache !== null) return this.listCache;
    // Ordered layer chain `[parent, self]`: parent rows first, then self
    // rows override in place (self shadows parent by id, self wins). A
    // Map keyed by id preserves the parent's position on override and
    // appends self-only ids. Absent parent ⇒ just self (unchanged).
    const byId = new Map<string, KnobDescriptor>();
    if (this.parentLayer) {
      for (const descriptor of this.parentLayer.list()) byId.set(descriptor.id, descriptor);
    }
    // Descriptor-known ids first (registration order), then value-only
    // ids (set without a prior descriptor registration).
    for (const [id, descriptor] of this.descriptors) {
      byId.set(id, { id, value: this.view.getSync(id)?.value, ...descriptor });
    }
    for (const { id, value } of this.view.listSync()) {
      if (this.descriptors.has(id)) continue;
      byId.set(id, { id, value });
    }
    const out = [...byId.values()];
    this.listCache = out;
    return out;
  }

  subscribe(id: string, listener: () => void): Unsubscribe {
    return this.view.subscribe(id, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.view.subscribeAll(listener);
  }

  /**
   * Subscribe to the typed change stream (ADR 75 notify seam). Each set /
   * register / dispatch that mutates a cell emits a `ChangeEvent`
   * (`{ key, value?, prev? }`) carrying the delta. Read-only and
   * fire-and-forget — an observer cannot affect the mutation. This is the
   * seam projections (StateDelta, timeline events, AG-UI) attach to;
   * `subscribe` above is the bare render-ping twin.
   *
   * TODO(notify-seam): promote to `KnobsHarnessProtocol` when a
   * protocol-typed (cross-package) projection needs it — class-only until a
   * consumer exists.
   */
  onChange(listener: (change: ChangeEvent<KnobPrimitive>) => void): Unsubscribe {
    // The view's change stream is ENTRY-typed (`{ id, value }`); the public
    // notify seam is VALUE-typed. Project entry → primitive, preserving
    // key-presence (`"value"`/`"prev" in c`) so add/update/remove classify the
    // same as before the View collapse.
    return this.view.onChange((c) => listener(toValueChange(c, (e) => e.value)));
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, KnobPrimitive>> {
    const out: Record<string, KnobPrimitive> = {};
    for (const { id, value } of this.view.listSync()) out[id] = value;
    return out;
  }

  importSnapshot(values: Readonly<Record<string, KnobPrimitive>>): void {
    // Wholesale replace via the view: keys absent from `values` are dropped from
    // BOTH the cache and the store; the snapshot's cells write through. The view
    // updates the whole cache FIRST then batch-pings the union — so invalidate
    // `listCache` BEFORE `replace` and a `useSyncExternalStore` consumer reading
    // during a ping sees the complete post-import list. `replace` is
    // change-SILENT; the single snapshot frame below IS the wire delta (not N
    // per-key deltas).
    //
    // TODO(store-phase-4): dead once the sweep deletes `SnapshotCapable` — the
    // session fold already routes this harness through `persist`/`hydrate`.
    const entries = Object.entries(values).map(([id, value]) => this.cell(id, value));
    this.listCache = null;
    this.view.replace(entries, this.storeCtx());
    this.publishStateFrame(this.freshStateFrame());
  }

  // ─────────── Checkpoint (CheckpointCapable) ───────────

  /**
   * The durability barrier: await every store write this harness kicked off the
   * critical path and surface the first failure. Rejecting here aborts the
   * caller's eviction — an un-flushed knob value must never be followed by an
   * unmount.
   */
  async persist(_ctx: PersistCtx): Promise<void> {
    await this.view.flush();
  }

  /**
   * Rebuild the sync projection from this harness's store partition. REPLACE
   * semantics — the store is the authority, so a cell it does not hold is
   * dropped from the projection. Invalidate `listCache` BEFORE the load so a
   * `useSyncExternalStore` consumer reading during the ping sees the hydrated
   * list.
   *
   * Emits the `knobs-state` snapshot frame, exactly as `importSnapshot` does:
   * a resumed session's subscribers hold pre-hydrate state and a wholesale
   * rebuild is one aggregate frame, never N per-key deltas.
   */
  async hydrate(ctx: HydrateCtx): Promise<void> {
    this.listCache = null;
    await this.view.hydrate({ scope: this.scopeId }, ctx.storeCtx, { replace: true });
    this.publishStateFrame(this.freshStateFrame());
  }

  /**
   * Copy the SOURCE session's cells onto this harness's partition — the fork
   * transport (checkpointing §5). A store-layer copy: nothing crosses the seam,
   * and the projection is deliberately left alone because the fork path always
   * runs `hydrate` after the branch fan-out.
   *
   * Idempotent by non-empty partition: a second branch into a scope that
   * already holds cells resolves without effect, so a retried fork never
   * clobbers writes the child made after the first one.
   */
  async branch(ctx: BranchCtx): Promise<void> {
    const mine = await this.store.query({ scope: this.scopeId }, ctx.storeCtx);
    if (mine.length > 0) return;
    const source = await this.store.query({ scope: knobsScope(ctx.fromSessionId) }, ctx.storeCtx);
    for (const entry of source) {
      await this.store.mutate({ put: { ...entry, scope: this.scopeId } }, ctx.storeCtx);
    }
  }

  /** The current state as a NEW frame — advances the version (a wholesale rebuild). */
  private freshStateFrame(): KnobsStateSnapshotFrame {
    return { ...this.stateSnapshotFrame(), version: ++this.stateVersion };
  }

  // ─────────── State channel (ADR 73) ───────────

  /**
   * The channel this harness owns — {@link ChannelSnapshotProvider}. The
   * session's `channelSnapshot("knobs-state")` renders {@link
   * channelSnapshotPayload} into the opening frame a fresh subscriber
   * receives before any live delta.
   */
  readonly snapshotChannel = KNOBS_STATE_CHANNEL;

  /**
   * {@link ChannelSnapshotProvider} — the current knob store as the
   * channel's opening frame. Delegates to {@link stateSnapshotFrame} (reads
   * the current version; does not advance it — this is an observation).
   */
  channelSnapshotPayload(): unknown {
    return this.stateSnapshotFrame();
  }

  /**
   * Current full state as a snapshot frame — the seed a late subscriber
   * applies before consuming live deltas. The channel is append-only and
   * bus-only (unjournaled); a subscriber that joins mid-session, or detects
   * a `version` gap, re-seeds from this. Reads the current version (does not
   * advance it — this is an observation, not a new frame).
   */
  stateSnapshotFrame(): KnobsStateSnapshotFrame {
    return {
      kind: "snapshot",
      version: this.stateVersion,
      values: this.exportSnapshot(),
      descriptors: this.wireDescriptors(),
    };
  }

  /**
   * The current descriptor set projected for the wire (friction #1) — every
   * knob's full {@link WireKnobDescriptor} (id, value, declared metadata), the
   * non-serializable `validate`/`schema` stripped. Derived from `list()` (the
   * layer-resolved descriptors+values the model sees), so it reflects the
   * parent-layer cascade identically.
   */
  private wireDescriptors(): readonly WireKnobDescriptor[] {
    return this.list().map(toWireDescriptor);
  }

  private emitStateDelta(ops: readonly JsonPatchOp[]): void {
    this.publishStateFrame({ kind: "delta", version: ++this.stateVersion, ops });
  }

  /**
   * The single StateDelta subscriber on the view's change stream (wired in the
   * constructor). The stream is ENTRY-typed (`{ id, value }`); classify via
   * `changeKind` (the entry object is present on add/update, absent on remove —
   * knobs never remove today, but the mapping is total) and unwrap the
   * primitive from the entry for the op value.
   */
  private projectStateDelta(change: ChangeEvent<KnobEntry>): void {
    const path = knobPointer(change.key);
    const kind = changeKind(change);
    const op: JsonPatchOp =
      kind === "remove"
        ? { op: "remove", path }
        : { op: kind === "add" ? "add" : "replace", path, value: change.value!.value };
    this.emitStateDelta([op]);
  }

  /**
   * Fan a state frame onto the substrate channel. Fire-and-forget, bus-only
   * (`phase: "delta"` is unjournaled per the default policy) — mirrors the
   * TasksHarness channel fan. Knob state is low-frequency, so we publish
   * unconditionally rather than probe for subscribers.
   */
  private publishStateFrame(frame: KnobsStateFrame): void {
    void Effect.runPromise(
      this.bus.append({
        id: generateId(),
        surface: "session",
        name: KNOBS_STATE_CHANNEL_FQN,
        phase: "delta",
        timestamp: Date.now(),
        // Stamped explicitly because this is a RAW `bus.append` — it bypasses both
        // `makeEvent` and `emitSignal`, so the construction-bound scope is not folded
        // in for it. `parentScope`, never `this.scopeId`: this frame IS the knobs
        // state channel a client subscribes to per session, so the composed key
        // (`<sessionId>:knobs`) made it unreachable — the whole reason the client-side
        // knob projection never received anything.
        scope: this.parentScope ?? {},
        payload: frame,
      } as Parameters<typeof this.bus.append>[0]),
    ).catch(() => undefined);
  }

  // ─────────── Inbox routing ───────────

  /**
   * `knobs:set` / `knobs:register` / `knobs:dispatch` are declared
   * commands — routed by the BaseHarness command registry before this
   * fallthrough. Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown knobs message type: ${msg.type}` }));
  }

  // ─────────── Internals ───────────

  private applySet(input: KnobsSetInput, ctx: StoreCtx = this.storeCtx()): void {
    // One write through the view: sync cache first (reads reflect it now),
    // durable store off the critical path via the seam, a render ping, and the
    // typed change the constructor-wired StateDelta channel projects — the whole
    // trio (dual-write + fireListeners + emitChange) collapsed. Invalidate
    // `listCache` BEFORE the write so a subscriber that reads during the ping
    // sees the fresh list. `ctx` is the enriched store-ctx the command handler
    // read inside the fiber (carrying the live op's `opId`); a direct caller
    // with no fiber falls back to base.
    this.listCache = null;
    this.view.write(this.cell(input.id, input.value), ctx);
  }

  /** A stored cell, stamped with this harness's store partition. */
  private cell(id: string, value: KnobPrimitive): KnobEntry {
    return { scope: this.scopeId, id, value };
  }

  private applyRegister(input: KnobsRegisterInput, ctx: StoreCtx = this.storeCtx()): void {
    this.descriptors.set(input.id, input.descriptor);
    const defaultValue = input.descriptor.defaultValue;
    // A registration that SEEDS a default (no prior cell) is a value mutation:
    // write through the view (ping + `add` change). A descriptor-only
    // registration mutates no cell → a bare render ping only (no store write, no
    // change). Invalidate `listCache` BEFORE either so a subscriber re-reads.
    const applied = !this.view.hasSync(input.id) && defaultValue !== undefined;
    this.listCache = null;
    if (applied) {
      this.view.write(this.cell(input.id, defaultValue), ctx);
    } else {
      this.view.notify(input.id);
    }
  }

  /**
   * Validation + dispatch — matches the v1 `knob_set` tool pipeline
   * field for field: exactly-one(name, group) → exists → type → options
   * → bounds → length/pattern → custom `validate`. On failure, returns
   * an error ContentBlock array; on success, mutates + returns a
   * confirmation message.
   */
  private executeDispatch(
    input: KnobsDispatchInput,
    ctx: StoreCtx = this.storeCtx(),
  ): readonly ContentBlock[] {
    const hasName = input.name !== undefined && input.name !== "";
    const hasGroup = input.group !== undefined && input.group !== "";

    if (hasName && hasGroup) return err("Provide either name or group, not both.");
    if (!hasName && !hasGroup) return err("Provide either name or group.");

    const all = this.list();

    if (hasName) {
      const knob = all.find((k) => k.id === input.name);
      if (!knob) {
        return err(`Unknown knob "${input.name}". Available: ${all.map((k) => k.id).join(", ")}`);
      }
      if (knob.readOnly) {
        return err(
          `Knob "${knob.id}" is read-only — it is managed by the application and cannot be set.`,
        );
      }
      const reason = validateValue(knob, input.value);
      if (reason) return err(reason);
      this.applySet({ id: knob.id, value: input.value }, ctx);
      return [{ type: "text", text: `Set ${knob.id} to ${fmt(input.value)}.` }];
    }

    // Group dispatch: read-only knobs are excluded from group writes;
    // type-check the remaining group first; mutate atomically.
    const members = all.filter((k) => k.group === input.group);
    const targets = members.filter((k) => !k.readOnly);
    if (targets.length === 0) {
      return err(
        members.length > 0
          ? `All knobs in group "${input.group}" are read-only — they are managed by the application and cannot be set.`
          : `No knobs found in group "${input.group}".`,
      );
    }
    const expected = targets[0]!.valueType;
    for (const t of targets) {
      if (t.valueType !== expected) {
        return err(
          `Type mismatch in group "${input.group}": "${t.id}" is ${t.valueType}, expected ${expected}.`,
        );
      }
    }
    for (const t of targets) {
      const reason = validateValue(t, input.value);
      if (reason) return err(reason);
    }
    for (const t of targets) this.applySet({ id: t.id, value: input.value }, ctx);
    const names = targets.map((t) => t.id).join(", ");
    return [
      {
        type: "text",
        text: `Set ${targets.length} knobs in group "${input.group}" to ${fmt(input.value)}: ${names}.`,
      },
    ];
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Project an ENTRY-typed change (the view's `{ id, value }` stream) onto a
 * VALUE-typed one (the public notify seam), preserving KEY-PRESENCE so
 * add/update/remove classify identically — `"value" in c` / `"prev" in c`, NOT
 * `!== undefined` (a stored value may legitimately be `undefined`).
 */
function toValueChange<T, V>(c: ChangeEvent<T>, valueOf: (t: T) => V): ChangeEvent<V> {
  const out: { key: string; value?: V; prev?: V } = { key: c.key };
  if ("value" in c) out.value = valueOf(c.value as T);
  if ("prev" in c) out.prev = valueOf(c.prev as T);
  return out;
}

function err(text: string): readonly ContentBlock[] {
  return [{ type: "text", text }];
}

function fmt(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function validateValue(desc: KnobDescriptor, value: KnobPrimitive): string | null {
  const expected: KnobValueType | undefined = desc.valueType;
  if (expected && typeof value !== expected) {
    return `Invalid type for "${desc.id}". Expected ${expected}, got ${typeof value}.`;
  }
  if (desc.options && desc.options.length > 0 && !desc.options.some((o) => o === value)) {
    return `Invalid value for "${desc.id}". Valid options: ${desc.options.map(fmt).join(", ")}`;
  }
  if (typeof value === "number") {
    if (desc.min !== undefined && value < desc.min) {
      return `Value for "${desc.id}" must be >= ${desc.min}. Got ${value}.`;
    }
    if (desc.max !== undefined && value > desc.max) {
      return `Value for "${desc.id}" must be <= ${desc.max}. Got ${value}.`;
    }
  }
  if (typeof value === "string") {
    if (desc.maxLength !== undefined && value.length > desc.maxLength) {
      return `Value for "${desc.id}" exceeds max length of ${desc.maxLength}. Got ${value.length} chars.`;
    }
    if (desc.pattern !== undefined && !new RegExp(desc.pattern).test(value)) {
      return `Value for "${desc.id}" does not match pattern: ${desc.pattern}`;
    }
  }
  if (desc.validate) {
    const result = desc.validate(value);
    if (result !== true) return `Validation failed for "${desc.id}": ${result}`;
  }
  return null;
}
