/**
 * `GatesController` — the reconciler-agnostic gate-wiring core.
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
 * subscription — the reconciler owns no gate wiring.
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
} from "@agentick/spec-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";

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
 */
export type GateKnobs = Pick<KnobsHarnessProtocol, "register" | "set" | "get" | "subscribe">;

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
   * latch via `set_knob`. Transient on verified gates: the predicate
   * re-engages at the next tick end if still unsatisfied.
   */
  clear(): void;
  /**
   * Postpone a latch gate (`deferred`) — the model must still face it
   * before completing. No-op on verified gates.
   */
  defer(): void;
  /**
   * **Verified gates, HOST-ONLY, audited.** Verified gates are cleared
   * by their predicate and their backing knob is read-only to the MODEL
   * (an unforgeable guarantee — `set_knob` cannot clear them). A HOST
   * override is legitimate (the host is trusted) but is an EXPLICIT,
   * auditable escape — it emits a {@link GateOverrideAudit} and does NOT
   * exist as a generic setter that would silently reopen the read-only
   * protection. Throws on latch gates (use {@link clear} there).
   */
  override(value: GateValue, reason?: string): void;
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
   * `set_knob` clear is observed). Mirrors `useGate`'s `stateRef`.
   */
  value: GateValue;
  /**
   * Verified-gate arming latch (sticky per registration). Verified gates
   * without `activateWhen` are armed from the first tick.
   */
  armed: boolean;
  /** Per-gate change notifier for handle subscribers. */
  readonly notifier: Notifier;
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
// gate-backing keys (the `GateEntry.notifier` here is the per-gate render-PING
// for handle subscribers — the pull twin, not a second delta source).
export class GatesController {
  private readonly deps: GatesControllerDeps;
  private readonly gates = new Map<string, GateEntry>();

  constructor(deps: GatesControllerDeps) {
    this.deps = deps;
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
      notifier: createNotifier(),
      knobUnsub: () => {},
      handle: undefined as unknown as GateHandle,
    };
    (entry as { handle: GateHandle }).handle = this.makeHandle(entry);
    this.gates.set(name, entry);

    void this.deps.knobs.register({ id: name, descriptor: this.knobRegistration(descriptor) });

    // Keep the synchronous mirror aligned with the knob so a model
    // `set_knob` clear (latch) is observed by subsequent ticks + by
    // handle subscribers, exactly as `useGate` re-read `state` per render.
    entry.knobUnsub = this.deps.knobs.subscribe(name, () => {
      const next = (this.deps.knobs.get(name) ?? "inactive") as GateValue;
      if (next !== entry.value) {
        entry.value = next;
        entry.notifier.notify();
      }
    });

    return entry.handle;
  }

  /** Remove a gate and tear down its knob subscription. */
  unregister(name: string): void {
    const entry = this.gates.get(name);
    if (!entry) return;
    entry.knobUnsub();
    this.gates.delete(name);
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

  /** Release a gate by name (host-side clear). No-op when unknown. */
  clear(name: string): void {
    this.gates.get(name)?.handle.clear();
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
      clear() {
        controller.transition(entry, "inactive");
      },
      defer() {
        if (!entry.verified) controller.transition(entry, "deferred");
      },
      override(value: GateValue, reason?: string) {
        if (!entry.verified) {
          throw new Error(
            `override() is a verified-gate escape; gate "${entry.name}" is a latch gate — use clear().`,
          );
        }
        controller.transition(entry, value);
        controller.deps.audit?.({
          kind: "gate:override",
          name: entry.name,
          value,
          at: Date.now(),
          ...(reason !== undefined ? { reason } : {}),
        });
      },
      subscribe(listener: () => void) {
        return entry.notifier.subscribe(listener);
      },
    };
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
    // the notifier, mirroring packages-next/knobs/src/channel.ts.
    void this.deps.knobs.set({ id: entry.name, value: next });
    entry.notifier.notify();
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
  /** Unified snapshot over ALL gates — tree-declared and programmatic. */
  list(): readonly GateInfo[];
  /** Release a gate by name (host-side clear). */
  clear(name: string): void;
}
