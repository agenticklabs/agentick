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
 * Snapshot/restore — `exportSnapshot()` / `importSnapshot()` round-trip
 * the value cells. Descriptors are NOT snapshotted (components re-
 * declare on remount).
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
import { BaseHarness, type Middleware, type Unsubscribe } from "@agentick/runtime-next";
import type {
  CollectionStore,
  ContentBlock,
  EventBus,
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
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";
import {
  changeKind,
  createChangeNotifier,
  createKeyedNotifier,
  type ChangeEvent,
  type ChangeNotifier,
  type KeyedNotifier,
} from "@agentick/pubsub-next";
import { ulid, type JsonPatchOp } from "@agentick/utils-next";
import { CollectionProjection } from "@agentick/store-next";
import type { ChannelSnapshotProvider } from "@agentick/spec-next";
import {
  KNOBS_STATE_CHANNEL,
  KNOBS_STATE_CHANNEL_FQN,
  knobPointer,
  type KnobsStateFrame,
  type KnobsStateSnapshotFrame,
} from "./channel.js";
import { createKnobStore, type KnobEntry, type KnobStoreQuery } from "./store.js";

// ============================================================================
// Harness
// ============================================================================

/**
 * Construction options for {@link KnobsHarness}. Minimal today — knobs takes its
 * substrate + layer-chain parent positionally; this carries the ADR 82 resolved
 * hook layer forwarded by the SessionHarness (via `buildSessionBridges`).
 */
export interface KnobsHarnessOptions {
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
   * `{ id, value }` cells only — descriptors are tree-derived and never stored.
   * It is the durable truth; the synchronous {@link CollectionProjection} is its
   * sync read cache (reads never touch the store). Injecting a durable adapter
   * (Postgres, …) is how knob values survive process restart; `hydrate()` loads
   * it back into the projection.
   */
  readonly store?: CollectionStore<KnobEntry, KnobStoreQuery>;
}

export class KnobsHarness
  extends BaseHarness<"knobs">
  implements KnobsHarnessProtocol, ChannelSnapshotProvider
{
  /**
   * The synchronous read PROJECTION of the value store (data-layer plan §3.5
   * P5) — `get` / `has` / `list` / `subscribe` read it during render, so knob
   * reads stay sync (never async-through-the-store). The shared
   * {@link CollectionProjection} owns the two moves this used to hand-roll: the
   * dual-write (sync cache first, durable {@link KnobEntry} store off the
   * critical path via {@link CollectionProjection.write}) and the merge
   * {@link CollectionProjection.hydrate}. The projection is a WRITE SINK beside
   * the harness's notify seam (`fireListeners` + the `changes` StateDelta
   * channel), never a source of it — every mutation writes it AND drives the
   * seam by hand, exactly as before. It stores values keyed by knob id; the
   * durable store holds `{ id, value }` cells only (descriptors are
   * tree-derived and never stored).
   */
  private readonly projection: CollectionProjection<KnobEntry, KnobStoreQuery>;
  private readonly descriptors = new Map<string, KnobRegistration>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();

  /**
   * The notify seam (ADR 75): typed push carrying the delta. Distinct from
   * `notifier` (bare render pings) — mutation sites emit a semantic
   * `ChangeEvent` here; projections (the StateDelta channel wired in the
   * constructor, and future timeline / AG-UI projections) subscribe via
   * {@link onChange}. The mutation logic stays ignorant of any specific
   * projection.
   */
  private readonly changes: ChangeNotifier<KnobPrimitive> = createChangeNotifier<KnobPrimitive>();

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
   * `dispatch` keeps v1 set_knob semantics: the Operation succeeds
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
    super("knobs", scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.parentLayer = parentLayer;
    this.projection = new CollectionProjection<KnobEntry, KnobStoreQuery>(
      options.store ?? createKnobStore(),
      (entry) => entry.id,
    );
    const scope = () => ({ sessionId: this.scopeId });
    this.set = this.command({
      name: "knobs:set",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: KnobsSetInput) => Effect.sync(() => this.applySet(i)),
    });
    this.register = this.command({
      name: "knobs:register",
      scope,
      handler: (i: KnobsRegisterInput) => Effect.sync(() => this.applyRegister(i)),
    });
    this.dispatch = this.command({
      name: "knobs:dispatch",
      scope,
      handler: (i: KnobsDispatchInput) => Effect.sync(() => this.executeDispatch(i)),
    });
    // Wire the StateDelta (ADR 73) projection onto the change stream:
    // mutation sites emit a semantic ChangeEvent; this projection derives the
    // JSON-Patch op. Decoupled so additional projections attach to the same
    // stream without touching the mutation logic.
    this.changes.onChange((change) => this.projectStateDelta(change));
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
    return this.projection.hasSync(id)
      ? this.projection.getSync(id)?.value
      : this.parentLayer?.get(id);
  }

  has(id: string): boolean {
    return this.projection.hasSync(id) || (this.parentLayer?.has(id) ?? false);
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
      byId.set(id, { id, value: this.projection.getSync(id)?.value, ...descriptor });
    }
    for (const { id, value } of this.projection.listSync()) {
      if (this.descriptors.has(id)) continue;
      byId.set(id, { id, value });
    }
    const out = [...byId.values()];
    this.listCache = out;
    return out;
  }

  subscribe(id: string, listener: () => void): Unsubscribe {
    return this.notifier.subscribe(id, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.notifier.subscribeAll(listener);
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
    return this.changes.onChange(listener);
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, KnobPrimitive>> {
    const out: Record<string, KnobPrimitive> = {};
    for (const { id, value } of this.projection.listSync()) out[id] = value;
    return out;
  }

  importSnapshot(values: Readonly<Record<string, KnobPrimitive>>): void {
    const oldKeys = new Set(this.projection.listSync().map((entry) => entry.id));
    const newKeys = new Set(Object.keys(values));
    const changed = new Set<string>([...oldKeys, ...newKeys]);
    // Wholesale replace: a key present before but absent from `values` is
    // dropped from BOTH the projection cache and the store (delete-not-present),
    // then the snapshot's cells dual-write through the projection. In every
    // real call path (seed, restore) the harness is fresh so the drop loop is a
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
    for (const [k, v] of Object.entries(values)) {
      this.projection.write({ id: k, value: v });
    }
    this.listCache = null;
    for (const id of changed) this.fireListeners(id);
    // Wholesale replacement — a fresh full-store frame, not N per-key deltas.
    this.publishStateFrame({
      kind: "snapshot",
      version: ++this.stateVersion,
      values: { ...values },
    });
  }

  /**
   * Load the durable value store into the sync projection — the future
   * manifest resume path (data-layer plan Phase 4 / BaseHarness §2.3). Reads
   * every stored cell and mirrors it into `values`, then invalidates the
   * `list()` cache and pings subscribers so a `useSyncExternalStore` consumer
   * re-reads. This is a MERGE (store cells overlay the projection), not a
   * clear-first replace — a fresh session's store is empty ⇒ a no-op.
   *
   * NOT wired into session resume in this run: `importSnapshot` remains the
   * active resume path (the snapshot rides `SessionSnapshot`). `hydrate()` is
   * the seam the Phase-4 manifest sweep flips to once the store is authority.
   */
  async hydrate(): Promise<void> {
    // The projection owns the store→cache merge and returns the keys it
    // loaded; the harness owns notification (the primitive is a write sink,
    // not a notifier). Ping each hydrated key so both per-knob and wildcard
    // subscribers re-read (mirrors importSnapshot's per-key fan-out rather than
    // a wildcard-only `notifyAll`).
    const keys = await this.projection.hydrate();
    this.listCache = null;
    for (const k of keys) this.fireListeners(k);
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
    return { kind: "snapshot", version: this.stateVersion, values: this.exportSnapshot() };
  }

  private emitStateDelta(ops: readonly JsonPatchOp[]): void {
    this.publishStateFrame({ kind: "delta", version: ++this.stateVersion, ops });
  }

  /**
   * The single StateDelta subscriber on the change stream (wired in the
   * constructor). Derives the JSON-Patch op from the change's value/prev
   * presence via `changeKind`: add → `add`, update → `replace`, remove →
   * `remove` (knobs don't remove today, but the mapping is total).
   */
  private projectStateDelta(change: ChangeEvent<KnobPrimitive>): void {
    const path = knobPointer(change.key);
    const kind = changeKind(change);
    const op: JsonPatchOp =
      kind === "remove"
        ? { op: "remove", path }
        : { op: kind === "add" ? "add" : "replace", path, value: change.value as KnobPrimitive };
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
        id: ulid(),
        surface: "session",
        name: KNOBS_STATE_CHANNEL_FQN,
        phase: "delta",
        timestamp: Date.now(),
        scope: { sessionId: this.scopeId },
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

  private applySet(input: KnobsSetInput): void {
    const prev = this.projection.getSync(input.id)?.value;
    // Dual-write through the projection: sync cache first (reads reflect it
    // now), durable store off the critical path. The notify seam below
    // (`fireListeners` + `changes`) is driven by hand, exactly as before — the
    // projection is a write sink beside it, never a source.
    this.projection.write({ id: input.id, value: input.value });
    this.listCache = null;
    this.fireListeners(input.id);
    // Emit the semantic change; the constructor-wired StateDelta projection
    // derives the JSON-Patch op. Prev present ⇒ update (existing id); absent
    // ⇒ add (new id) — KnobPrimitive never holds `undefined`, so prev
    // presence is an exact existed-check.
    this.changes.emitChange(
      prev !== undefined
        ? { key: input.id, value: input.value, prev }
        : { key: input.id, value: input.value },
    );
  }

  private applyRegister(input: KnobsRegisterInput): void {
    this.descriptors.set(input.id, input.descriptor);
    const defaultValue = input.descriptor.defaultValue;
    const applied = !this.projection.hasSync(input.id) && defaultValue !== undefined;
    if (applied) {
      // A registration that SEEDS a default value is a value mutation, so it
      // dual-writes through the projection. A descriptor-only registration
      // mutates no cell → no store write.
      this.projection.write({ id: input.id, value: defaultValue });
    }
    this.listCache = null;
    this.fireListeners(input.id);
    // A registration is a change only when it seeds a value (an `add`); a
    // descriptor-only registration mutates no cell → no change event.
    if (applied && defaultValue !== undefined) {
      this.changes.emitChange({ key: input.id, value: defaultValue });
    }
  }

  /**
   * Validation + dispatch — matches the v1 `set_knob` tool pipeline
   * field for field: exactly-one(name, group) → exists → type → options
   * → bounds → length/pattern → custom `validate`. On failure, returns
   * an error ContentBlock array; on success, mutates + returns a
   * confirmation message.
   */
  private executeDispatch(input: KnobsDispatchInput): readonly ContentBlock[] {
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
      this.applySet({ id: knob.id, value: input.value });
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
    for (const t of targets) this.applySet({ id: t.id, value: input.value });
    const names = targets.map((t) => t.id).join(", ");
    return [
      {
        type: "text",
        text: `Set ${targets.length} knobs in group "${input.group}" to ${fmt(input.value)}: ${names}.`,
      },
    ];
  }

  private fireListeners(id: string): void {
    this.notifier.notify(id);
  }
}

// ============================================================================
// Helpers
// ============================================================================

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
