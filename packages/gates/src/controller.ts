/**
 * `GatesController` — the compiler-agnostic gate-wiring core.
 *
 * ONE wiring logic, two front-ends. The verification wiring that used
 * to live inside the React `useGate` hook — register the backing knob,
 * arm the descriptor, evaluate the predicate at tick-end, auto-clear /
 * re-engage, fail-closed on throw, drive loop continuation — lives here
 * now. `useGate` (React) and the programmatic `session.gates` API are
 * thin front-ends that register descriptors into the SAME controller;
 * neither re-implements the wiring. This mirrors `useKnob` →
 * `KnobsHarness`.
 *
 * Gates are NOT a harness. A gate owns no independent state — its value
 * IS a knob value in the session's {@link KnobsHarnessProtocol}. The
 * controller holds only the gate registry (descriptors + armed flags +
 * a synchronous value mirror). It takes its collaborators INJECTED (no
 * React, no context reads):
 *
 *   - `knobs`       — register/set/get/subscribe the backing knob.
 *   - `loopControl` — block/continue the loop (a value or a getter, so
 *                     a per-execution loop bridge is tracked live).
 *   - `audit`       — optional sink for the host `.override()` escape.
 *
 * Tick-end evaluation is DRIVEN (ADR 67), not subscribed: the session's
 * continuation decision (`session.notifyLifecycle`) calls
 * {@link handleTickEnd} with the settled {@link TickResult} once per
 * tick. A blocking gate holds the loop open by calling `continueAfterTick`
 * on the injected `loopControl` seam; the session drains that seam and
 * folds the hold into its `TickEndForwardDecision`. There is no per-mount
 * subscription — the compiler owns no gate wiring.
 *
 * @see ./descriptor.ts (pure descriptor types + `gate()`)
 * @see ./react/use-gate.ts (React front-end)
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type {
  KnobPrimitive,
  KnobRegistration,
  KnobsHarnessProtocol,
  TickResult,
  Unsubscribe,
} from "@agentick/spec";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub";

import {
  GATE_OPTIONS,
  VERIFIED_GATE_OPTIONS,
  isVerifiedGate,
  type GateDescriptor,
  type GateValue,
} from "./descriptor.js";

// ============================================================================
// Injected seams
// ============================================================================

/**
 * The loop continuation seam — the block/continue surface a gate drives
 * when the loop would otherwise stop. Structurally the spec's
 * `LoopBridge`; named locally so the controller has no hard dependency
 * on a bridge slot.
 */
export interface LoopControlSeam {
  continueAfterTick(reason: string): void;
  stopAfterTick(reason: string): void;
}

/**
 * The subset of the knobs harness the controller consumes. Kept
 * structural so the controller works against the real `KnobsHarness`,
 * `fakeKnobsHarness`, or `stubKnobsHarness` interchangeably.
 *
 * TODO(value-cell): this Pick IS the "model-writable value cell" seam —
 * validation, audit, channel projection, persistence — that gates borrow
 * from knobs. If a third cell-shaped harness appears (sampling? roots?),
 * extract the cell as its own substrate primitive and make BOTH knobs and
 * gates compositions over it (stratification, not separation). Ruled
 * deliberate composition 2026-07-24 — see
 * docs/proposals/v2/three-audiences-plan.md "value-cell stratification".
 */
export type GateKnobs = Pick<KnobsHarnessProtocol, "register" | "set" | "get" | "subscribe">;

/**
 * Where a verified-gate override originated — the audit's authorization
 * identity. `"host"` is a trusted in-process caller (`session.gate(name)
 * .override(...)`); `"wire"` is a remote caller that reached the
 * `gates:override` command over the dynamic lane (both are trusted, but
 * the trail must distinguish them). Defaults to `"host"` when
 * {@link GateHandle.override} is called without an explicit origin.
 */
export type GateOverrideOrigin = "host" | "wire";

/**
 * Audit record emitted by the trusted-host {@link GateHandle.override}
 * escape. Verified gates are code-cleared and read-only to the model;
 * a host override is legitimate but must be explicit + auditable, never
 * a silent setter.
 */
export interface GateOverrideAudit {
  readonly kind: "gate:override";
  readonly name: string;
  readonly value: GateValue;
  readonly reason?: string;
  readonly at: number;
  /**
   * The override's authorization identity — `"host"` (default, a trusted
   * in-process caller) or `"wire"` (the `GatesHarness` `gates:override`
   * command, reached over the dynamic lane). Stamped by
   * {@link GateHandle.override}'s `origin` argument.
   */
  readonly origin: GateOverrideOrigin;
}

/**
 * The journaled-mutation seam a {@link GatesController} routes its public
 * `clear` / `defer` / `override` verbs through. The {@link GatesHarness} binds
 * one whose methods dispatch the `gates:clear` / `gates:defer` /
 * `gates:override` commands (so a host-side release is an audited, journaled
 * Operation — the sibling contract every other harness mutation already has).
 * A controller with no bound sink (a bare test controller, no harness) falls
 * back to the raw synchronous transition — same effect, no journal.
 *
 * Admission (journaled command vs. direct) is the ONLY axis this seam selects;
 * both paths bottom out at the SAME `rawClear` / `rawDefer` / `rawOverride`
 * transition logic, so there is one mutation implementation, not two.
 */
export interface GateMutationSink {
  clear(name: string): Promise<void>;
  defer(name: string): Promise<void>;
  override(name: string, value: GateValue, reason?: string): Promise<void>;
}

export interface GatesControllerDeps {
  readonly knobs: GateKnobs;
  /**
   * The loop continuation seam. A value pins one bridge; a getter is
   * re-read at each tick-end so a per-execution loop bridge is tracked
   * live (mirrors how `useGate` read `useLoopControl()` fresh).
   */
  readonly loopControl: LoopControlSeam | (() => LoopControlSeam);
  /**
   * Optional audit sink for the host `.override()` escape. Wire it to
   * the substrate bus (or any observer) so overrides are traceable. If
   * omitted, overrides still apply — they just aren't recorded.
   */
  readonly audit?: (event: GateOverrideAudit) => void;
  /**
   * Optional parent (inherited) gate layer (ADR 34 cascade). Its gates
   * fall through into this controller's reads (`get` / `list`, self
   * shadows parent by name) and are evaluated by THIS controller's
   * tick-end pass — the parent owns no tick-end source of its own; a
   * child layer drives it. Absent today (the session constructs its
   * controller with `parent: undefined`) ⇒ single-layer behavior,
   * byte-identical to no chain. The seam lets a future app tier drop in.
   */
  readonly parent?: GatesParentLayer;
}

/**
 * The read + inherited-evaluation surface a child {@link GatesController}
 * consumes from its parent (app) layer. A `GatesController` satisfies it
 * directly, so any controller can be another's parent. Kept structural so
 * an app tier can be any conforming source. `GatesHandle` is the CURATED
 * session surface; this is the (internal-ish) LAYER contract, so it also
 * carries {@link evaluateInherited} — how a child drives its parent's
 * evaluation against the child's tick.
 */
export interface GatesParentLayer {
  get(name: string): GateHandle | undefined;
  list(): readonly GateInfo[];
  /**
   * Evaluate THIS layer's own gates against a child layer's tick,
   * skipping any `shadowed` names (a descendant owns the effective gate
   * by that name). Recurses to its own parent, accumulating shadowed
   * names, so a multi-level chain evaluates each name exactly once. The
   * parent's own knobs + loop + notifiers are used (correct layer
   * ownership — an app gate's state lives in the app layer).
   */
  evaluateInherited(result: TickResult, shadowed: ReadonlySet<string>): Promise<void>;
}

// ============================================================================
// Public read shapes
// ============================================================================

/** Unified read row over a registered gate (tree-declared or programmatic). */
export interface GateInfo {
  readonly name: string;
  readonly value: GateValue;
  readonly verified: boolean;
  readonly description: string;
}

/**
 * Per-gate handle. Returned from {@link GatesController.register} /
 * {@link GatesController.get}; surfaced to adopters as `session.gate(name)`.
 */
export interface GateHandle {
  readonly name: string;
  readonly descriptor: GateDescriptor;
  /** True for verified (satisfied) gates; false for latch (activateWhen) gates. */
  readonly verified: boolean;
  /** Current gate value — the synchronous mirror of the backing knob. */
  readonly value: GateValue;
  /** `value !== "inactive"` — the gate is currently blocking exit. */
  readonly engaged: boolean;
  /**
   * Release the gate — the host-side equivalent of the model clearing a
   * latch via `knob_set`. Transient on verified gates: the predicate
   * re-engages at the next tick end if still unsatisfied.
   *
   * Async + journaled: routes through the `gates:clear` command when the
   * controller is harness-owned (the sibling contract — `knobs.set` /
   * `state.set` are async journaled Operations too). A bare controller
   * (no harness) applies the transition directly; the promise still
   * resolves.
   */
  clear(): Promise<void>;
  /**
   * Postpone a latch gate (`deferred`) — the model must still face it
   * before completing. No-op on verified gates. Async + journaled (see
   * {@link clear}).
   */
  defer(): Promise<void>;
  /**
   * **Verified gates, HOST-ONLY, audited.** Verified gates are cleared
   * by their predicate and their backing knob is read-only to the MODEL
   * (an unforgeable guarantee — `knob_set` cannot clear them). A HOST
   * override is legitimate (the host is trusted) but is an EXPLICIT,
   * auditable escape — it emits a {@link GateOverrideAudit} and does NOT
   * exist as a generic setter that would silently reopen the read-only
   * protection. Rejects on latch gates (use {@link clear} there).
   *
   * Async + journaled: routes through `gates:override`. The audit's
   * `origin` is stamped by the command path — `"wire"` when the override
   * arrived over the dynamic lane, `"host"` for a direct in-process call
   * — so it is no longer a caller argument.
   */
  override(value: GateValue, reason?: string): Promise<void>;
  /** Subscribe to value changes for this gate. */
  subscribe(listener: () => void): Unsubscribe;
}

// ============================================================================
// Internal registry entry
// ============================================================================

interface GateEntry {
  name: string;
  descriptor: GateDescriptor;
  verified: boolean;
  /**
   * Synchronous source of truth for the gate's value — updated
   * immediately on `transition` (so same-tick logic sees the new value)
   * and re-synced from the knob whenever the knob changes (so a model
   * `knob_set` clear is observed). Mirrors `useGate`'s `stateRef`.
   */
  value: GateValue;
  /**
   * Verified-gate arming latch (sticky per registration). Verified gates
   * without `activateWhen` are armed from the first tick.
   */
  armed: boolean;
  /** Teardown for the knob subscription that keeps `value` in sync. */
  knobUnsub: Unsubscribe;
  /** Stable handle instance. */
  readonly handle: GateHandle;
}

// ============================================================================
// Controller
// ============================================================================

// NOTE(notify-seam, ADR 75): GatesController deliberately owns NO
// `ChangeNotifier`. A gate value IS a knob value — every engage/clear/latch
// goes through `deps.knobs.set` → `KnobsHarness.emitChange`, so gate
// transitions already surface on the knobs notify seam (`knobs.onChange`). A
// gates-owned change stream would DOUBLE-EMIT the same fact. A projection that
// wants gate transitions subscribes `knobs.onChange` and filters for the
// gate-backing keys. The `changes` KeyedNotifier here is the render-PING twin
// (the family-grammar `subscribe(name)` / `subscribeAll` surface + the per-gate
// handle subscribers), not a second delta source.
export class GatesController {
  private readonly deps: GatesControllerDeps;
  private readonly gates = new Map<string, GateEntry>();

  /**
   * ONE keyed render-ping notifier (name → listeners, plus a wildcard
   * channel). Fires on every transition and on register / unregister
   * (topology). Backs the family-grammar `subscribe(name)` / `subscribeAll`
   * AND each {@link GateHandle}'s own `subscribe(listener)` — the per-gate
   * notifier is now a bucket on this shared keyed notifier, keyed by name,
   * so a subscription taken before a gate registers still fires once it does.
   */
  private readonly changes: KeyedNotifier = createKeyedNotifier();

  /**
   * The journaled-mutation admission seam ({@link GateMutationSink}). Defaults
   * to the raw synchronous transition (a bare controller, no harness); the
   * {@link GatesHarness} swaps in a sink that routes through its `gates:*`
   * commands via {@link bindMutations}, so a host-side release journals.
   */
  private mutations: GateMutationSink = {
    clear: async (name) => {
      this.rawClear(name);
    },
    defer: async (name) => {
      this.rawDefer(name);
    },
    override: async (name, value, reason) => {
      this.rawOverride(name, value, reason, "host");
    },
  };

  constructor(deps: GatesControllerDeps) {
    this.deps = deps;
  }

  /**
   * Bind the journaled-mutation sink — called once by the owning
   * {@link GatesHarness} after it constructs its commands. From then on
   * `clear` / `defer` / `override` on this controller (and its handles) route
   * through the harness's `gates:*` commands (audited, journaled). A controller
   * never bound keeps the raw-transition default.
   */
  bindMutations(sink: GateMutationSink): void {
    this.mutations = sink;
  }

  /**
   * Register (or replace) a gate by name. Registers the backing knob
   * (three-state select for latch; read-only two-state for verified),
   * wires a knob subscription that keeps the synchronous value mirror in
   * sync, and returns a stable {@link GateHandle}. Idempotent by name —
   * last-writer-wins on the descriptor (like ToolBridge / knobs).
   */
  register(name: string, descriptor: GateDescriptor): GateHandle {
    const verified = isVerifiedGate(descriptor);

    const existing = this.gates.get(name);
    if (existing) {
      // Replace the descriptor in place; keep the entry (and its handle
      // identity + current value + subscribers) stable.
      existing.descriptor = descriptor;
      existing.verified = verified;
      existing.armed = false;
      void this.deps.knobs.register({ id: name, descriptor: this.knobRegistration(descriptor) });
      return existing.handle;
    }

    const entry: GateEntry = {
      name,
      descriptor,
      verified,
      value: (this.deps.knobs.get(name) ?? "inactive") as GateValue,
      armed: false,
      knobUnsub: () => {},
      handle: undefined as unknown as GateHandle,
    };
    (entry as { handle: GateHandle }).handle = this.makeHandle(entry);
    this.gates.set(name, entry);

    void this.deps.knobs.register({ id: name, descriptor: this.knobRegistration(descriptor) });

    // Keep the synchronous mirror aligned with the knob so a model
    // `knob_set` clear (latch) is observed by subsequent ticks + by
    // handle subscribers, exactly as `useGate` re-read `state` per render.
    entry.knobUnsub = this.deps.knobs.subscribe(name, () => {
      const next = (this.deps.knobs.get(name) ?? "inactive") as GateValue;
      if (next !== entry.value) {
        entry.value = next;
        this.changes.notify(name);
      }
    });

    // Topology ping: a new gate appeared — `subscribeAll` observers re-read.
    this.changes.notify(name);
    return entry.handle;
  }

  /** Remove a gate and tear down its knob subscription. */
  unregister(name: string): void {
    const entry = this.gates.get(name);
    if (!entry) return;
    entry.knobUnsub();
    this.gates.delete(name);
    // Topology ping: the gate is gone — `subscribeAll` observers re-read.
    this.changes.notify(name);
  }

  /**
   * The gate's handle, or undefined when unknown. Falls through to the
   * parent layer when self has no gate by that name (self shadows parent).
   */
  get(name: string): GateHandle | undefined {
    return this.gates.get(name)?.handle ?? this.deps.parent?.get(name);
  }

  /**
   * Unified snapshot over ALL registered gates (tree-declared +
   * programmatic), across the layer chain — parent gates first, then self
   * gates override in place (self shadows parent by name). Absent parent
   * ⇒ just self (unchanged).
   */
  list(): readonly GateInfo[] {
    const byName = new Map<string, GateInfo>();
    if (this.deps.parent) {
      for (const info of this.deps.parent.list()) byName.set(info.name, info);
    }
    for (const entry of this.gates.values()) {
      byName.set(entry.name, {
        name: entry.name,
        value: entry.value,
        verified: entry.verified,
        description: entry.descriptor.description,
      });
    }
    return [...byName.values()];
  }

  /** True iff a gate by this name is registered (self or inherited parent). */
  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * Release a gate by name (host-side clear). Async + journaled (routes through
   * `gates:clear` when harness-owned). A bare controller no-ops on an unknown
   * name; over the wire the `gates:clear` command rejects with `GateNotFound`.
   */
  clear(name: string): Promise<void> {
    return this.mutations.clear(name);
  }

  /**
   * Subscribe to a single gate's changes by name — fires on every transition
   * plus register / unregister of that gate. Works before the gate registers
   * (the family-grammar contract; the bucket is keyed, lifecycle-independent).
   */
  subscribe(name: string, listener: () => void): Unsubscribe {
    return this.changes.subscribe(name, listener);
  }

  /** Subscribe to EVERY gate change (transitions + register / unregister). */
  subscribeAll(listener: () => void): Unsubscribe {
    return this.changes.subscribeAll(listener);
  }

  // ─────────── The single wiring logic (shared by both front-ends) ───────────

  /**
   * Evaluate every registered gate against a settled tick (ADR 67).
   * Driven by `session.notifyLifecycle` once per tick-end. Serial — the
   * caller awaits it, so async verified predicates are awaited in order
   * (deterministic, matches v1 lifecycle semantics). A blocking gate
   * calls `continueAfterTick` on the injected loop seam; the session
   * drains that seam to compose its continuation decision.
   */
  async handleTickEnd(result: TickResult): Promise<void> {
    // Snapshot the entries so a gate registered/unregistered mid-eval
    // doesn't perturb this tick's pass.
    for (const entry of [...this.gates.values()]) {
      await this.evaluate(entry, result);
    }
    // Then the inherited layer(s) — self gates shadow parent gates by
    // name, so pass this layer's names as already-handled. No-op when no
    // parent (the seam is present, unused, until an app tier is wired).
    await this.deps.parent?.evaluateInherited(result, new Set(this.gates.keys()));
  }

  /**
   * Evaluate this layer's own gates against a descendant's tick (see
   * {@link GatesParentLayer.evaluateInherited}). Skips `shadowed` names,
   * then recurses to its own parent accumulating this layer's names.
   */
  async evaluateInherited(result: TickResult, shadowed: ReadonlySet<string>): Promise<void> {
    for (const entry of [...this.gates.values()]) {
      if (shadowed.has(entry.name)) continue;
      await this.evaluate(entry, result);
    }
    if (this.deps.parent) {
      await this.deps.parent.evaluateInherited(
        result,
        new Set([...shadowed, ...this.gates.keys()]),
      );
    }
  }

  private async evaluate(entry: GateEntry, result: TickResult): Promise<void> {
    const { name, descriptor } = entry;

    if (isVerifiedGate(descriptor)) {
      // Optional arming scope: while unarmed the gate is dormant —
      // `satisfied` is not evaluated and the gate never blocks. The
      // first tick where `activateWhen` fires arms it (sticky); verification
      // takes over immediately, same tick.
      if (!entry.armed) {
        if (descriptor.activateWhen === undefined || descriptor.activateWhen(result)) {
          entry.armed = true;
        } else {
          return;
        }
      }

      // Level-triggered: verify every tick; engage/clear from the
      // predicate alone. Fail-closed — a throwing predicate counts as
      // unsatisfied (the lifecycle store would otherwise swallow the
      // error and leave the gate in its previous state).
      let ok = false;
      try {
        ok = await descriptor.satisfied(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[@agentick/gates] verified gate "${name}" predicate threw; ` +
            `treating as unsatisfied (fail-closed).`,
          err,
        );
      }
      if (ok) {
        this.transition(entry, "inactive");
        return;
      }
      this.transition(entry, "active");
      if (!result.shouldContinue) {
        this.loop().continueAfterTick(`gate:${name}`);
      }
      return;
    }

    // Edge-triggered latch: activate only when inactive — once engaged,
    // the model is in control.
    if (entry.value === "inactive" && descriptor.activateWhen(result)) {
      this.transition(entry, "active");
    }

    // Block completion when engaged.
    if (entry.value !== "inactive" && !result.shouldContinue) {
      if (entry.value === "deferred") {
        // Un-defer: the model must face the instructions before completing.
        this.transition(entry, "active");
      }
      this.loop().continueAfterTick(`gate:${name}`);
    }
  }

  // ─────────── Internals ───────────

  private makeHandle(entry: GateEntry): GateHandle {
    const controller = this;
    return {
      name: entry.name,
      get descriptor() {
        return entry.descriptor;
      },
      get verified() {
        return entry.verified;
      },
      get value() {
        return entry.value;
      },
      get engaged() {
        return entry.value !== "inactive";
      },
      // Public mutations route through the admission sink (journaled command
      // when harness-owned, raw transition otherwise) — one grammar with the
      // sibling harnesses. The raw transition logic lives in `rawClear` /
      // `rawDefer` / `rawOverride`, which the harness commands drive.
      clear() {
        return controller.mutations.clear(entry.name);
      },
      defer() {
        return controller.mutations.defer(entry.name);
      },
      override(value: GateValue, reason?: string) {
        return controller.mutations.override(entry.name, value, reason);
      },
      subscribe(listener: () => void) {
        return controller.changes.subscribe(entry.name, listener);
      },
    };
  }

  // ─────────── Raw mutations (the transition logic the commands drive) ─────

  /**
   * Release a gate — the raw synchronous transition. The `gates:clear` command
   * and the default (unbound) mutation sink both bottom out here. No-op when
   * the name is unknown (self layer only; parent gates clear via their own
   * controller's handle).
   */
  rawClear(name: string): void {
    const entry = this.gates.get(name);
    if (entry) this.transition(entry, "inactive");
  }

  /** Postpone a latch gate — the raw transition. No-op on verified / unknown. */
  rawDefer(name: string): void {
    const entry = this.gates.get(name);
    if (entry && !entry.verified) this.transition(entry, "deferred");
  }

  /**
   * The verified-gate audited override — the raw transition + audit emit. The
   * `gates:override` command and the default sink drive it. Throws on a latch
   * gate (the verified-only rule); no-op when the name is unknown. `origin`
   * distinguishes the wire escape from the trusted in-process caller on the
   * emitted {@link GateOverrideAudit}.
   */
  rawOverride(
    name: string,
    value: GateValue,
    reason: string | undefined,
    origin: GateOverrideOrigin,
  ): void {
    const entry = this.gates.get(name);
    if (!entry) return;
    if (!entry.verified) {
      throw new Error(
        `override() is a verified-gate escape; gate "${name}" is a latch gate — use clear().`,
      );
    }
    this.transition(entry, value);
    this.deps.audit?.({
      kind: "gate:override",
      name,
      value,
      at: Date.now(),
      origin,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Set a gate's value. Updates the synchronous mirror immediately (so
   * same-tick logic + subscribers see it) and mirrors to the backing
   * knob fire-and-forget (the durable, model-facing cell). The knob
   * subscription started in `register` re-confirms the mirror when the
   * async set lands — a no-op when already aligned.
   */
  private transition(entry: GateEntry, next: GateValue): void {
    if (entry.value === next) return;
    entry.value = next;
    // TODO(state-deltas): a gate's boolean value ALREADY flows to clients as
    // a knob JSON-Patch delta via this write-through (KnobsHarness emits on
    // the knobs-state channel, ADR 73). What isn't projected is gate-specific
    // info (open/closed reason, hit counts, predicate metadata). When that's
    // wanted client-side, add a `gates-state` snapshot+delta channel here at
    // the notifier, mirroring packages/knobs/src/channel.ts.
    void this.deps.knobs.set({ id: entry.name, value: next });
    this.changes.notify(entry.name);
  }

  private loop(): LoopControlSeam {
    const lc = this.deps.loopControl;
    return typeof lc === "function" ? lc() : lc;
  }

  private knobRegistration(descriptor: GateDescriptor): KnobRegistration {
    const verified = isVerifiedGate(descriptor);
    return {
      defaultValue: "inactive" as KnobPrimitive,
      valueType: "string",
      description: descriptor.description,
      group: "gates",
      options: (verified ? VERIFIED_GATE_OPTIONS : GATE_OPTIONS) as readonly KnobPrimitive[],
      ...(verified ? { readOnly: true } : {}),
    };
  }
}

/**
 * Curated session-facing surface over a {@link GatesController} —
 * exposed as `session.gates` (mirrors `session.knobs` → `KnobsHandle`).
 * Structural subset; the controller satisfies it directly.
 */
export interface GatesHandle {
  /** Register (or replace) a gate by name; returns its handle. */
  register(name: string, descriptor: GateDescriptor): GateHandle;
  /** The gate's handle, or undefined when unknown. */
  get(name: string): GateHandle | undefined;
  /** True iff a gate by this name is registered. */
  has(name: string): boolean;
  /** Unified snapshot over ALL gates — tree-declared and programmatic. */
  list(): readonly GateInfo[];
  /** Release a gate by name (host-side clear). Async + journaled. */
  clear(name: string): Promise<void>;
  /** Subscribe to one gate's changes by name (family grammar). */
  subscribe(name: string, listener: () => void): Unsubscribe;
  /** Subscribe to every gate change (transitions + topology). */
  subscribeAll(listener: () => void): Unsubscribe;
}
