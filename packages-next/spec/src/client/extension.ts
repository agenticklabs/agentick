/**
 * `ClientExtension` shape + lifecycle event registry.
 *
 * Three extension surfaces, all parallel to `BaseHarness`:
 *
 *   1. Middleware  — chain of responsibility wrapping request/subscribe
 *      (Promise-native by default; `effectMiddleware()` adapter for
 *      Effect-native authors).
 *   2. Lifecycle handlers — per-event verdict semantics.
 *   3. `install(installer)` — bus subscriber + namespace registration.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"Extensions"
 */

import type { EventBus } from "../protocol/bus.js";
import type { Cursor } from "../protocol/event-log.js";
import type { EventQuery } from "../data/events.js";
import type { JsonRpcError } from "../wire/json-rpc.js";
import type { SubscriptionScope } from "../wire/scope.js";
import type { WireMethod, WireParams, WireResult } from "../wire/params.js";
import type { ClientTransport, EventFrame } from "./transport.js";
import type { TransportError } from "./transport-error.js";

// ============================================================================
// Request / subscribe middleware
// ============================================================================

export interface RequestInput<M extends WireMethod = WireMethod> {
  readonly method: M;
  readonly params: WireParams<M>;
  readonly signal?: AbortSignal;
}

export type RequestMiddleware = <M extends WireMethod>(
  req: RequestInput<M>,
  next: (req: RequestInput<M>) => Promise<WireResult<M>>,
) => Promise<WireResult<M>>;

export interface SubscribeInput {
  readonly scope: SubscriptionScope;
  readonly query?: EventQuery;
  readonly fromCursor?: Cursor;
}

export type SubscribeMiddleware = (
  input: SubscribeInput,
  next: (input: SubscribeInput) => AsyncIterable<EventFrame>,
) => AsyncIterable<EventFrame>;

// ============================================================================
// Lifecycle handlers with per-event merge rules
// ============================================================================

export type ClientMergeKind =
  | "observer" // result is void; every handler runs; no merge
  | "first-non-null-wins" // first non-null result wins; remaining handlers skip
  | "any-reconnect-wins"; // any "reconnect" overrides "give-up"

export interface LifecycleEventSpec<TInput, TResult, TMerge extends ClientMergeKind> {
  input: TInput;
  result: TResult;
  merge: TMerge;
}

export type ReconnectDecision = "reconnect" | "give-up";
export type AuthExpiredDecision = "refresh" | "re-authenticate" | "fail";
export type EvictionDecision = "resubscribe-from-oldest" | "resubscribe-from-latest" | "give-up";

/**
 * Canonical client lifecycle events. Adopters extend via declaration
 * merging:
 *
 * ```ts
 * declare module "@agentick/spec-next" {
 *   interface ClientLifecycleEvents {
 *     "custom:event": LifecycleEventSpec<CustomInput, CustomResult, "observer">;
 *   }
 * }
 * ```
 */
export interface ClientLifecycleEvents {
  "connection:opening": LifecycleEventSpec<{ transport: ClientTransport }, void, "observer">;
  "connection:opened": LifecycleEventSpec<{ transport: ClientTransport }, void, "observer">;
  "connection:lost": LifecycleEventSpec<
    { reason: TransportError },
    ReconnectDecision,
    "any-reconnect-wins"
  >;
  "auth:expired": LifecycleEventSpec<
    { sessionId?: string; reason: string },
    AuthExpiredDecision,
    "first-non-null-wins"
  >;
  "auth:challenge": LifecycleEventSpec<
    { challengeId: string; method: string; acr?: string },
    unknown, // proof — typed by ADR 34
    "first-non-null-wins"
  >;
  "subscription:evicted": LifecycleEventSpec<
    { subscriptionId: string; oldestAvailable: Cursor },
    EvictionDecision,
    "first-non-null-wins"
  >;
  "rpc:error": LifecycleEventSpec<
    { method: WireMethod; params: unknown; error: JsonRpcError },
    void,
    "observer"
  >;
}

export type LifecycleHandlerFor<S extends LifecycleEventSpec<unknown, unknown, ClientMergeKind>> = (
  input: S["input"],
) => S["result"] | null | undefined | Promise<S["result"] | null | undefined>;

// ============================================================================
// ClientExtension shape
// ============================================================================

export interface ClientExtension {
  readonly name: string;

  /** One-time install at client construction. */
  install?(installer: ClientInstaller): void | Promise<void>;

  /** Wraps every transport.request call. */
  request?: RequestMiddleware;

  /** Wraps every transport.subscribe call. */
  subscribe?: SubscribeMiddleware;

  /** Lifecycle handlers — partial map of `ClientLifecycleEvents`. */
  handlers?: {
    readonly [K in keyof ClientLifecycleEvents]?: LifecycleHandlerFor<ClientLifecycleEvents[K]>;
  };
}

// ============================================================================
// ClientInstaller — passed to install()
// ============================================================================

export interface ClientInstaller {
  readonly clientId: string;
  readonly transport: ClientTransport;
  readonly bus: EventBus;
  registerNamespace<N extends string, T>(name: N, namespace: T): void;
  onClose(handler: () => void | Promise<void>): void;
}

// ============================================================================
// ClientNamespaces — declaration-merge slot for extension-registered surfaces
// ============================================================================

/**
 * Adopter-extended namespace registry. Extensions add entries via
 * declaration merging; the client type widens to expose them.
 *
 * ```ts
 * declare module "@agentick/spec-next" {
 *   interface ClientNamespaces {
 *     offline: { pending(): Promise<unknown[]>; flush(): Promise<void> };
 *   }
 * }
 * ```
 */
export interface ClientNamespaces {}
