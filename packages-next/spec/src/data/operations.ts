/**
 * Operation and event-category types.
 *
 * Three categories of "thing that flows through the system":
 *
 *   - Operations:    typed commands with phase lifecycle and outcomes
 *   - Discrete:      notifications, no command lifecycle
 *   - Channel:       named per-session streams with retention
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The mental model
 */

import type { EventEnvelope, EventScope, EventSurface } from "./events.js";

/**
 * Operation — the unit of work driven through `BaseHarness.runOperation`.
 *
 * Carries typed input, with phantom type parameters for the result (`R`)
 * and error (`E`) channels. The phantoms are NOT runtime fields; they
 * exist purely for TypeScript inference at call sites. Implementations
 * may attach them but should not rely on their presence at runtime.
 *
 * Operations emit a sequence of `EventEnvelope`s:
 *   requested ─► before? ─► delta* ─► terminal
 *
 * Idempotency: each operation has a stable `opId`. Re-running with the
 * same opId returns the cached terminal payload via
 * `OperationJournal.lookupTerminal`.
 */
export interface Operation<I, R = unknown, E = unknown> {
  /** Stable identity. Caller-supplied (gateway boundary) or system ULID. */
  readonly opId: string;

  /** Causality: parent operation that initiated this one. */
  readonly parentOpId?: string;

  /** Request bundle id, when many operations belong to one user request. */
  readonly correlationId?: string;

  /** Surface emitting this operation. */
  readonly surface: EventSurface;

  /** Hierarchical name: `<surface>:<domain>:<action>`. */
  readonly name: string;

  /** Scope context. */
  readonly scope: EventScope;

  /** Typed input. */
  readonly input: I;

  /**
   * Phantom for return-type inference. Not present at runtime.
   * @internal
   */
  readonly __r?: R;

  /**
   * Phantom for error-type inference. Not present at runtime.
   * @internal
   */
  readonly __e?: E;
}

/**
 * Discrete event — notification, no command lifecycle.
 *
 * Has no `opId`, no `phase`, no `outcome` field (though the underlying
 * envelope has those fields; they're just not meaningful here).
 * Optional `parentOpId` for causal linkage to an enclosing operation.
 *
 * Examples:
 *   reconciler:async:resolved
 *   reconciler:suspended
 *   cluster:node:joined
 *   gateway:transport:connected
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §Discrete event envelope
 */
export interface DiscreteEvent {
  /** Unique envelope id. */
  readonly id: string;

  /** Optional causality link. */
  readonly parentOpId?: string;

  readonly surface: EventSurface;
  readonly name: string;
  readonly scope: EventScope;
  readonly payload?: unknown;
  readonly tags?: readonly string[];
  readonly timestamp: number;
}

/**
 * Channel event — typed entry in a named per-session stream.
 *
 * A channel event extends the general envelope with a session-scoped
 * monotonic offset (`channelSequence`) and a constrained name pattern
 * (`session:channel:<name>`).
 *
 * Channels are subscribed with offset semantics (`from: "latest" |
 * "beginning" | { sequence }`) and have configurable retention.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The Channel event envelope
 */
export interface ChannelEvent<T = unknown> extends EventEnvelope {
  readonly surface: "session";
  readonly name: `session:channel:${string}`;
  readonly payload: T;
  /** Per-session monotonic offset within this channel. */
  readonly channelSequence: number;
}
