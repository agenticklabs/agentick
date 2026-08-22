/**
 * `SubscriptionBridge` — registry of long-lived subscription intents.
 *
 * Components in the JSX tree (`<Cron>`, `<Webhook>`, `<EventListener>`)
 * declare an intent + handler at mount; external drivers (the
 * scheduler for cron, an HTTP server for webhooks, a bus subscriber
 * for event listeners) call `dispatch(id, event)` when their trigger
 * fires. The bridge invokes the handler with a `SubscriptionCtx`
 * carrying an AbortSignal that re-declarations cancel.
 *
 * Intents live only as long as their declaration: a resumed session
 * re-declares them on its first render, handler and all.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

import type { SubscriptionIntent, Unsubscribe } from "@agentick/spec";
import { createNotifier } from "@agentick/pubsub";

import type { SubscriptionsHarness } from "./harness.js";

// ============================================================================
// Surface
// ============================================================================

export interface SubscriptionCtx {
  readonly id: string;
  /**
   * Session id when the subscription is declared inside a session's
   * JSX tree. `"app"` when declared at the app level (extensions).
   */
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /**
   * Free-form metadata propagated by the driver — tenant id for
   * connector subscriptions, source-protocol for cross-protocol
   * routers, etc.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type SubscriptionHandler = (event: unknown, ctx: SubscriptionCtx) => void | Promise<void>;

/**
 * The SERIALIZABLE description of one subscription fire — the signal form
 * (ADR 51 §1.2) the `subscriptions:dispatch` command carries.
 *
 * Deliberately data-only: no handler, no ctx, no AbortSignal. The bound
 * handler is reached through the runner's CONSTRUCTION-BOUND registry lookup
 * ({@link SubscriptionBridge.invoker}), which is what lets the same op be
 * driven from the inbox/wire — where no closure exists — as well as from an
 * in-process driver.
 */
export interface SubscriptionDispatchInput {
  /** The declared {@link SubscriptionIntent}'s id — the routing key. */
  readonly id: string;
  /** Session id stamped on the handler ctx (`"app"` for app-level bridges). */
  readonly sessionId: string;
  /** The driver's trigger payload, opaque to the bridge. */
  readonly event: unknown;
  /** Driver-propagated metadata (tenant id, source protocol, …). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * The bound handler invocation for ONE live intent, resolved from the
 * bridge's registry. Closes over the live entry (its handler + the
 * `AbortController` a re-declaration trips) and rebuilds the
 * {@link SubscriptionCtx} from the per-fire `event` + `metadata`.
 *
 * This is the seam that keeps {@link SubscriptionDispatchInput} data-only: a
 * runner holds the lookup at construction and reconstructs the invocation from
 * the signal, rather than capturing a thunk per fire.
 */
export type SubscriptionInvoker = (
  event: unknown,
  metadata: Readonly<Record<string, unknown>>,
) => Promise<void>;

/**
 * Injected capability that wraps every handler invocation (ADR 92 Family 1 §2).
 *
 * `withSubscriptions` supplies {@link SubscriptionsHarness.runDispatch}, which
 * runs the fire as a journaled `subscriptions:command:dispatch` operation —
 * giving a time-triggered ingress the guard seam and the audit record it
 * otherwise lacks. Omitted (the bare bridge), `dispatch` invokes the handler
 * directly.
 *
 * `invoke` is the already-resolved invocation for THIS fire — the decorator
 * `next`. An adopter-supplied runner that only wants to observe/wrap (tracing,
 * rate limiting) calls it and never needs the registry. The harness runner does
 * NOT use it: its body re-resolves through the construction-bound lookup so the
 * in-process path and the inbox/wire path run one code path.
 */
export type SubscriptionDispatchRunner = (
  input: SubscriptionDispatchInput,
  invoke: () => Promise<void>,
) => Promise<void>;

export interface SubscriptionBridge {
  declare(intent: SubscriptionIntent, handler: SubscriptionHandler): Unsubscribe;
  /** All currently-declared intents. Drivers read this. */
  list(): readonly SubscriptionIntent[];
  /** Fire the handler bound to `id`. Driver-side. */
  dispatch(
    id: string,
    event: unknown,
    options?: { readonly metadata?: Readonly<Record<string, unknown>> },
  ): Promise<void>;
  /**
   * Resolve the bound handler invocation for `id` WITHOUT the operation
   * envelope, or `undefined` when nothing live is declared under it.
   *
   * The registry seam a {@link SubscriptionDispatchRunner} holds at
   * construction so its op can carry serializable data only. Not a second
   * dispatch path — calling the returned invoker bypasses the operation
   * envelope, which is exactly what the op BODY wants and nothing else does.
   */
  invoker(id: string): SubscriptionInvoker | undefined;
  subscribe(listener: () => void): Unsubscribe;
  /**
   * The operation harness wrapping dispatch, when one was installed
   * (`withSubscriptions` always installs one). The registration point for
   * guards, middleware, and command hooks on subscription fires:
   *
   *     bridges.subscriptions?.harness?.guard((input) =>
   *       quietHours() ? { kind: "veto", reason: "quiet-hours" } : undefined,
   *     );
   *
   * Absent on a bare `createSubscriptionBridge()` (tests, adopters driving the
   * registry with no app around it).
   */
  readonly harness?: SubscriptionsHarness;
}

// ============================================================================
// In-memory implementation
// ============================================================================

interface LiveEntry {
  readonly intent: SubscriptionIntent;
  readonly handler: SubscriptionHandler;
  readonly controller: AbortController;
}

export interface CreateSubscriptionBridgeOptions {
  /** Session id stamped onto the ctx — defaults to "app". */
  readonly sessionId?: string;
  /**
   * Wrap every handler invocation (ADR 92 Family 1 §2). `withSubscriptions`
   * passes {@link SubscriptionsHarness.runDispatch} so each fire becomes a
   * journaled, guardable `subscriptions:command:dispatch` operation. Omitted,
   * the handler is invoked directly — the bare-bridge behavior.
   */
  readonly runDispatch?: SubscriptionDispatchRunner;
  /**
   * The harness backing {@link runDispatch}, surfaced as
   * {@link SubscriptionBridge.harness} so adopters holding only
   * `bridges.subscriptions` can register guards / middleware / hooks on
   * subscription fires. Purely a reachability handle — the bridge never calls
   * it; `runDispatch` is the capability.
   */
  readonly harness?: SubscriptionsHarness;
}

export function createSubscriptionBridge(
  options: CreateSubscriptionBridgeOptions = {},
): SubscriptionBridge {
  const live = new Map<string, LiveEntry>();
  const listeners = createNotifier();
  const sessionId = options.sessionId ?? "app";
  const runDispatch = options.runDispatch;

  const notify = (): void => listeners.notify();

  /**
   * Bind the live entry for `id` into a per-fire invocation. Resolved fresh at
   * every call site so a re-declaration between a fire's admission and its
   * execution runs the CURRENT handler under the CURRENT abort controller.
   */
  const resolveInvoker = (id: string): SubscriptionInvoker | undefined => {
    const entry = live.get(id);
    if (entry === undefined) return undefined;
    return async (event, metadata) => {
      const ctx: SubscriptionCtx = {
        id,
        sessionId,
        signal: entry.controller.signal,
        metadata,
      };
      await entry.handler(event, ctx);
    };
  };

  return {
    ...(options.harness !== undefined ? { harness: options.harness } : {}),
    declare(intent, handler): Unsubscribe {
      // Re-declaration aborts any prior controller.
      const prior = live.get(intent.id);
      if (prior) prior.controller.abort();
      const controller = new AbortController();
      const entry: LiveEntry = { intent, handler, controller };
      live.set(intent.id, entry);
      notify();
      return () => {
        const current = live.get(intent.id);
        if (current && current.handler === handler) {
          current.controller.abort();
          live.delete(intent.id);
          notify();
        }
      };
    },
    list(): readonly SubscriptionIntent[] {
      const out: SubscriptionIntent[] = [];
      for (const e of live.values()) out.push(e.intent);
      return out;
    },
    async dispatch(id, event, opts): Promise<void> {
      // ADMISSION, not work (ADR 92): a fire with nothing declared under `id`
      // is a driver bug — no work unit exists, so no operation is opened and
      // no terminal is journaled. Stays PRE-OP, deliberately.
      const invoker = resolveInvoker(id);
      if (invoker === undefined) {
        throw new Error(`SubscriptionBridge: no handler declared for id=${id}`);
      }
      const metadata = opts?.metadata ?? {};
      if (runDispatch === undefined) {
        await invoker(event, metadata);
        return;
      }
      await runDispatch({ id, sessionId, event, metadata }, () => invoker(event, metadata));
    },
    invoker(id): SubscriptionInvoker | undefined {
      return resolveInvoker(id);
    },
    subscribe(listener): Unsubscribe {
      return listeners.subscribe(listener);
    },
  };
}
