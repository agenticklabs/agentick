/**
 * Event envelope and query types.
 *
 * Every event flowing through the system — operation lifecycle phases,
 * discrete notifications, channel publishes — shares the canonical
 * `EventEnvelope` shape. Subscribers filter via `EventQuery`.
 *
 * @see docs/proposals/v2/blueprint/10-events-handlers-inbox.md
 */

/**
 * Hierarchical surface identifier. The first segment of an event name.
 *
 *   <surface>:<domain>:<action>
 *
 * The seven core surfaces correspond to the seven harnesses in v2.
 * Optional-wrapper surfaces (cluster, gateway) are added when the
 * corresponding package is in use.
 */
export type EventSurface =
  | "app"
  | "session"
  | "loop"
  | "compiler"
  | "formatter"
  | "model"
  | "tool"
  | "sandbox"
  | "mcp"
  | "knobs"
  | "state"
  | "gates"
  | "resources"
  | "skills"
  | "cluster"
  | "gateway"
  | (string & {});

/**
 * Operation lifecycle phase.
 *
 *   requested ─► before? ─► delta* ─► terminal
 *
 * Discrete events (notifications without an operation lifecycle) MAY
 * use any phase value but conventionally use "terminal" with no opId.
 *
 * @see docs/proposals/v2/blueprint/01-harness-principle.md §The phase contract
 */
export type EventPhase = "requested" | "before" | "delta" | "terminal";

/**
 * Empty-seed augmentation slot for harness-specific identifier
 * dimensions on {@link EventScope}. Each harness package with its
 * own routing identifier augments this via module declaration:
 *
 * @example
 *     // In @agentick/sandbox/augment.ts:
 *     declare module "@agentick/spec" {
 *       interface EventScopeExtensions {
 *         readonly sandboxId?: string;
 *       }
 *     }
 *
 *     // In @agentick/mcp/augment.ts (client subpath):
 *     declare module "@agentick/spec" {
 *       interface EventScopeExtensions {
 *         readonly mcpConnectionId?: string;
 *       }
 *     }
 *
 * Mirrors the `HookBridges` empty-seed pattern. `@agentick/spec` stays
 * harness-agnostic — only framework-core identity dimensions live in
 * the canonical {@link EventScope}; harness-specific dimensions live
 * in the augmenting packages.
 *
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EventScopeExtensions {}

/**
 * Scope context attached to every event. Identifies the runtime
 * coordinates the event belongs to. Optional fields are populated as
 * applicable.
 *
 * Augmentable via {@link EventScopeExtensions} — harness packages
 * add their own identifier dimensions there, not by modifying this
 * type.
 */
export interface EventScope extends EventScopeExtensions {
  readonly appId?: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly parentSessionId?: string;
  /** Spawn ancestry chain. Inherited from v1 StreamEventBase. */
  readonly spawnPath?: readonly string[];
  /** Populated by the cluster wrapper when present. */
  readonly nodeId?: string;
  /** Populated by the gateway wrapper when present. */
  readonly gatewayId?: string;
  /**
   * Identity scope key — WHO this event's work is on behalf of
   * (ADR 48). The identity axis, twin of the work-path dimensions
   * above. Opaque, hierarchical-by-convention (e.g. `"acme/user-42"`);
   * identity-scoped stores namespace by it and resolve up
   * (user → tenant → global). Stamped authoritatively by
   * `BaseHarness` from its construction-bound principal — not
   * per-operation, so it cannot be spoofed by an op (ADR 45).
   * Absent for principal-less deployments.
   */
  readonly principal?: string;
  /**
   * Provenance — the gate through which the operation entered the
   * system (ADR 51). The second core identity dimension, twin of
   * {@link principal}: stamped **at the gates** (the wire resolver
   * stamps `"wire"`, inbox command dispatch defaults `"inbox"`, tool
   * dispatch stamps `"model"`, direct calls default `"host"`) and
   * trusted downstream — never re-derived. Together with principal
   * (subject), the event `name` (verb), the scope (target), and the
   * causal chain, `origin` completes the journal as the authorization
   * audit log: who, via which gate, did what, to what.
   *
   * Carries **facts, never decisions** — nothing consults it for
   * enforcement; enforcement happened at the boundary that stamped it.
   */
  readonly origin?: OperationOrigin;
  /**
   * The full authenticated ingress identity (ADR 34/51 §4.1) — the
   * STRUCTURED twin of {@link principal}. Where `principal` is the scalar
   * identity-scope key (the "who" projected to a string), this carries the
   * whole {@link import("../wire/authorizer.js").IngressIdentity}: the
   * adopter-shaped `user` record and the credential's `scopes`.
   *
   * Stamped at the wire boundary: the gateway threads the per-request
   * ingress identity onto its `wire:<method>` op so a before-hook
   * (`onBeforeWire<...>`) can read WHO is calling and reshape params
   * accordingly. Absent off the wire path (in-process calls carry no
   * ingress identity → `undefined`), and never client-settable — the
   * gateway populates it from the identity it authenticated, not from
   * request params.
   *
   * A fact on the identity axis (twin of {@link principal}/{@link origin}),
   * not a decision: nothing consults it for enforcement.
   */
  readonly identity?: import("../wire/authorizer.js").IngressIdentity;
}

/**
 * The gate through which an operation entered the system (ADR 51).
 *
 * - `"host"`   — direct in-process call (adopter code holding a reference)
 * - `"tree"`   — app-internal logic in the rendered tree (via a bridge)
 * - `"model"`  — a model-originated action (tool dispatch); inside the
 *                process, intentionally untrusted — the capability-policy
 *                subject (ADR 51 §5/§6)
 * - `"inbox"`  — cross-harness / cross-node message delivery
 * - `"wire"`   — an authenticated client through the projection boundary
 * - `"system"` — framework-internal housekeeping
 */
export type OperationOrigin = "host" | "tree" | "model" | "inbox" | "wire" | "system";

/**
 * Canonical event envelope. Every event published to the bus or
 * appended to the journal has this shape.
 *
 * Operation lifecycle events include `opId` and follow the phase
 * contract. Discrete events have no opId. Channel events use a
 * dedicated extension (see `ChannelEvent` in operations.ts).
 */
export interface EventEnvelope {
  /** Unique envelope id (ULID recommended). */
  readonly id: string;

  /** Present on operation lifecycle events. */
  readonly opId?: string;

  /**
   * Parent operation id. Present on inner operations spawned by a
   * surrounding `runOperation`. Auto-populated by `BaseHarness` from
   * the ambient `RuntimeContext.opId` (via FiberRef). Subscribers can
   * filter `parentOpId === undefined` to see only top-level ops.
   */
  readonly parentOpId?: string;

  readonly surface: EventSurface;

  /** Hierarchical name: `<surface>:<domain>:<action>`. */
  readonly name: string;

  readonly phase: EventPhase;

  /** Present when `phase === "terminal"`. */
  readonly outcome?: CommandOutcome;

  /** ISO milliseconds since epoch. */
  readonly timestamp: number;

  readonly scope: EventScope;

  /** Phase-specific structured payload. */
  readonly payload?: unknown;

  readonly tags?: readonly string[];

  /** Present on outcome === "failed". */
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly data?: unknown;
  };
}

/**
 * Alias for `EventEnvelope`. The terms are interchangeable; "envelope"
 * emphasizes the shape, "event" emphasizes the role.
 */
export type ProtocolEvent = EventEnvelope;

/**
 * Subscriber filter.
 */
export interface EventQuery {
  readonly surface?: EventSurface | readonly EventSurface[];
  readonly name?: NameQuery;
  readonly phase?: EventPhase | readonly EventPhase[];
  readonly outcome?: CommandOutcome | readonly CommandOutcome[];
  readonly tagsAny?: readonly string[];
  readonly scope?: Partial<EventScope>;
}

/**
 * Hierarchical-name matching modes.
 */
export type NameQuery =
  | { readonly exact: string }
  | { readonly prefix: string }
  | { readonly segments: readonly string[] }
  | { readonly wildcard: string };

// Forward declaration import-loop break — CommandOutcome lives in outcomes.ts.
// Re-exported here for ergonomics so consumers can `import { CommandOutcome }
// from "@agentick/spec/data/events"` without crossing files.
import type { CommandOutcome } from "./outcomes.js";
export type { CommandOutcome };
