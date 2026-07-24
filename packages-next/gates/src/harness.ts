/**
 * `GatesHarness` — the slim command surface over the {@link GatesController}.
 *
 * Gates was a controller, not a harness: `gates/src/` shipped the wiring core
 * (register the backing knob, evaluate predicates at tick-end, drive loop
 * continuation) with ZERO command declarations, so no wire client could reach
 * it. The dynamic-command lane routes an `exposure: "wire"` verb to a
 * per-surface inbox (`<surface>:<sessionId>:<surface>`) plus a
 * `<surface>:commands` meta-verb — i.e. {@link BaseHarness} machinery. This
 * harness supplies exactly that, and nothing more.
 *
 * **The ownership inversion (ADR 27).** The controller USED to be constructed
 * loose in `session-bridges.ts` and stapled onto the bridge bundle. Now the
 * harness CONSTRUCTS AND OWNS the ONE controller and exposes it as
 * {@link controller}; `session-bridges` staples `harness.controller` onto
 * `bridges.gates`, so every existing consumer (`useGate`, `session.gates`,
 * `session.notifyLifecycle → handleTickEnd`) keeps resolving the SAME instance.
 * The controller's behavior is untouched — the harness only adds a command
 * front-end that delegates to it.
 *
 * **Still deliberately NOT snapshot-visible (ADR 27).** A gate owns no
 * independent state — the gate's value IS a knob value, snapshot-captured by
 * `KnobsHarness`. So the harness does not augment `HookBridges` and is not
 * `SnapshotCapable`; it is a pure verb surface. See {@link augment}.
 *
 * The four declared commands (ALL `exposure: "wire"`) delegate straight to the
 * controller:
 *   - `gates:list`     → {@link GatesController.list}.
 *   - `gates:clear`    → the named gate's `clear()`.
 *   - `gates:defer`    → the named gate's `defer()` (latch gates only; a no-op
 *                        on verified gates, per the controller).
 *   - `gates:override` → the named gate's `override()` — the verified-gate,
 *                        audited escape. The command stamps `origin: "wire"` on
 *                        the {@link GateOverrideAudit} (the verified-only rule
 *                        and the latch-gate throw stay in the controller).
 *
 * A missing gate rejects with a typed {@link GateNotFound} (errors over nulls).
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { Effect } from "effect";
import { BaseHarness, getContext } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec-next";
import { GateNotFound, HandlerError } from "@agentick/spec-next";

import {
  GatesController,
  type GatesControllerDeps,
  type GateInfo,
  type GateOverrideOrigin,
} from "./controller.js";
import type { GateValue } from "./descriptor.js";

const SURFACE = "gates" as const;

/**
 * Construction deps for {@link GatesHarness} — exactly the
 * {@link GatesControllerDeps} the harness forwards to the ONE controller it
 * builds. The harness is a thin front-end: it owns no state of its own beyond
 * the controller, so its deps ARE the controller's.
 */
export interface GatesHarnessDeps extends GatesControllerDeps {}

/** Wire input for `gates:clear`. */
export interface GatesClearInput {
  readonly name: string;
}
/** Wire input for `gates:defer`. */
export interface GatesDeferInput {
  readonly name: string;
  readonly reason?: string;
}
/** Wire input for `gates:override`. */
export interface GatesOverrideInput {
  readonly name: string;
  readonly value: GateValue;
  readonly reason: string;
}

export class GatesHarness extends BaseHarness<"gates"> {
  /**
   * The ONE {@link GatesController} the session shares. Constructed and owned
   * here; `session-bridges` staples this onto `bridges.gates`, so `useGate`,
   * `session.gates`, and the tick-end evaluator all converge on this instance.
   */
  readonly controller: GatesController;

  /** `gates:list` — a snapshot over every registered gate. */
  readonly list: () => Promise<readonly GateInfo[]>;
  /** `gates:clear` — release a gate by name (host-side clear semantics). */
  readonly clear: (input: GatesClearInput) => Promise<void>;
  /** `gates:defer` — postpone a latch gate by name. */
  readonly defer: (input: GatesDeferInput) => Promise<void>;
  /** `gates:override` — the verified-gate audited escape, stamped `origin: "wire"`. */
  readonly override: (input: GatesOverrideInput) => Promise<void>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    deps: GatesHarnessDeps,
  ) {
    super(SURFACE, scopeId, journal, bus, inbox);
    this.controller = new GatesController(deps);

    const scope = () => ({ sessionId: this.scopeId });

    // Commands carry no input SCHEMA — like every sibling harness command
    // (`knobs:set`, `state:set`, `resources:read`), the wire payload is trusted
    // pass-through and the handler types its own input; the wire SHAPE is
    // documented by `WireMethods` (wire-augment.ts). `gates:list` takes no input,
    // so it is wrapped to a zero-arg method.
    const listCommand = this.command({
      name: "gates:list",
      exposure: "wire",
      scope,
      handler: () => Effect.sync(() => this.controller.list()),
    });
    this.list = () => listCommand(undefined);

    this.clear = this.command({
      name: "gates:clear",
      exposure: "wire",
      scope,
      handler: (i: GatesClearInput) =>
        Effect.gen(this, function* () {
          const gate = this.controller.get(i.name);
          if (gate === undefined) return yield* Effect.fail(new GateNotFound({ name: i.name }));
          gate.clear();
        }),
    });

    this.defer = this.command({
      name: "gates:defer",
      exposure: "wire",
      scope,
      // `reason` rides the wire shape for parity with `override`, but the
      // controller's `defer()` takes no reason (latch defer carries no audit) —
      // accepted and dropped here; controller behavior is untouched.
      handler: (i: GatesDeferInput) =>
        Effect.gen(this, function* () {
          const gate = this.controller.get(i.name);
          if (gate === undefined) return yield* Effect.fail(new GateNotFound({ name: i.name }));
          gate.defer();
        }),
    });

    this.override = this.command({
      name: "gates:override",
      exposure: "wire",
      scope,
      handler: (i: GatesOverrideInput) =>
        Effect.gen(this, function* () {
          // Origin rides the op scope (dynamic-commands stamps `origin: "wire"`
          // on the inbox message; the command manufacture folds it onto the
          // Operation scope, so `getContext` sees it in-fiber). Any non-wire
          // invocation collapses to "host". The verified-only rule + latch throw
          // stay in `override()`; we only add the audit's authorization identity.
          const rc = yield* getContext;
          const origin: GateOverrideOrigin = rc.origin === "wire" ? "wire" : "host";
          const gate = this.controller.get(i.name);
          if (gate === undefined) return yield* Effect.fail(new GateNotFound({ name: i.name }));
          gate.override(i.value, i.reason, origin);
        }),
    });
  }

  /**
   * Declared commands are routed by the BaseHarness command registry before
   * this fallthrough; only unknown message types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown gates message type: ${msg.type}` }));
  }
}
