/**
 * `SubscriptionsHarness` — subscription dispatch as an OPERATION (ADR 92
 * Family 1 §2).
 *
 * A cron tick, a webhook POST, a bus event: each is *ingress*. Before this
 * harness, a driver reached into {@link SubscriptionBridge.dispatch} and the
 * declared handler simply ran — no guard could deny it, and the journal kept no
 * record that the system had been woken from outside. Time-triggered ingress
 * was the one entry point with no operation grammar around it.
 *
 * The harness declares exactly ONE verb — `subscriptions:dispatch` (op name
 * `subscriptions:command:dispatch`) — and `withSubscriptions` injects its
 * {@link runDispatch} into the bridge. Every fire now runs the full phase
 * contract: `requested` → guard/middleware/hook cascade → `terminal`, with
 * `requested` + `terminal` PERSISTED under the default journaling policy.
 *
 * **Signal form (ADR 51 §1.2).** The command input is serializable data only —
 * `{ id, sessionId, event, metadata }`. The handler FUNCTION is not an input;
 * the harness holds a construction-bound lookup into the bridge's live registry
 * ({@link SubscriptionBridge.invoker}) and reconstructs the invocation from the
 * signal. That is what makes the verb genuinely inbox-addressable: a message of
 * type `subscriptions:dispatch` fires the subscription with no closure in play,
 * through the identical body an in-process driver drives.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md §1.2
 */

import { Effect } from "effect";
import { BaseHarness, type BaseHarnessOptions, type Middleware } from "@agentick/runtime";
// Load this package's own EventScope augmentation (`subscriptionId`) —
// this file uses the augmented dim in op scopes, and a consumer that
// reaches this module DEEPLY (bypassing the barrel that imports
// augment.ts) would otherwise fail to typecheck. Same fix as the
// credentials/live harnesses (ADR 92 Slice B latent-hazard finding).
import "./augment.js";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";

import type { SubscriptionDispatchInput, SubscriptionInvoker } from "./bridge.js";

// ============================================================================
// Command lifecycle hooks (ADR 80/83) — typed CommandRegistry augmentation.
// ============================================================================
//
// The registry key is the canonical `subscriptions:dispatch` form (the
// `:command:` infix `deriveHookNames` strips), so it mints
// `onBeforeSubscriptionsDispatch` / `onAfterSubscriptionsDispatch` and
// `ctx.op === "SubscriptionsDispatch"` inside a guard.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "subscriptions:dispatch": { input: SubscriptionDispatchInput; output: void };
  }
}

// ============================================================================
// Options
// ============================================================================

/**
 * `extends BaseHarnessOptions` so every slot the base accepts — `parentScope`,
 * `principal`, telemetry, metadata, the interceptor fold — arrives without being
 * re-declared here and re-forwarded by hand. Standing alone, this interface
 * silently dropped every base option a caller passed, and the next thing the base
 * gains would be dropped the same way.
 */
export interface SubscriptionsHarnessOptions extends BaseHarnessOptions<unknown, "subscriptions"> {
  /**
   * CONSTRUCTION-BOUND lookup into the live subscription registry — in
   * practice `(id) => bridge.invoker(id)`. The seam that keeps the declared
   * command's input data-only (ADR 51 §1.2): the op body resolves the bound
   * handler from the id it was given rather than receiving a function.
   *
   * Resolved per fire, so a re-declaration between admission and execution runs
   * the current handler. Returning `undefined` fails the operation — by the
   * time the body runs the intent was withdrawn, which IS work-path failure
   * (unlike the bridge's pre-op admission check).
   */
  readonly resolveInvoker: (id: string) => SubscriptionInvoker | undefined;
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83) — the parent
   * scope's interceptors, folded in at construction so app-scope guards wrap
   * subscription fires. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the AppHarness. Keeps inheritance
   * live so a LATER `app.guard()` reaches this harness's ops, not just the
   * construction snapshot.
   */
  readonly interceptorParent?: BaseHarness;
}

// ============================================================================
// Harness
// ============================================================================

export class SubscriptionsHarness extends BaseHarness<"subscriptions"> {
  private readonly resolveInvoker: SubscriptionsHarnessOptions["resolveInvoker"];

  get id(): string {
    return this.scopeId;
  }

  /**
   * The declared verb (ADR 51) — `subscriptions:dispatch`, op name
   * `subscriptions:command:dispatch`. Public because it is the wire/inbox
   * shape of a fire: hand it the signal and the subscription runs, guards and
   * journal included.
   */
  readonly dispatch: (input: SubscriptionDispatchInput) => Promise<void>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: SubscriptionsHarnessOptions,
  ) {
    // Forward the WHOLE bag: nothing to enumerate, so nothing to forget. Every
    // hand-picked `super({ inheritedInterceptors, interceptorParent })` was a place
    // a new base option would silently vanish — and `parentScope` did exactly that.
    super("subscriptions", scopeId, journal, bus, inbox, options);
    this.resolveInvoker = options.resolveInvoker;
    this.dispatch = this.command<SubscriptionDispatchInput, void, unknown>({
      name: "subscriptions:dispatch",
      description: "Fire the handler bound to a declared subscription intent.",
      // Work-path dims: the owning session (`"app"` for app-level bridges) plus
      // the per-intent routing dimension, so an observer can filter one
      // subscription's fires out of the stream.
      scope: (input) => ({ sessionId: input.sessionId, subscriptionId: input.id }),
      handler: (input) =>
        Effect.tryPromise({
          try: () => this.invoke(input),
          // Re-raise verbatim: a handler that throws is a FAILED fire, and the
          // terminal carries the original cause rather than a wrapper.
          catch: (cause: unknown) => cause,
        }),
    });
  }

  /**
   * The {@link SubscriptionDispatchRunner} `withSubscriptions` injects into the
   * bridge. Bound as a property so it can be passed by reference.
   *
   * The decorator's `invoke` thunk is intentionally NOT taken: the body
   * re-resolves through {@link SubscriptionsHarnessOptions.resolveInvoker} so
   * the in-process driver path and the inbox/wire path — where no thunk exists
   * — are ONE code path with one resolution instant.
   */
  readonly runDispatch = async (input: SubscriptionDispatchInput): Promise<void> => {
    await this.dispatch(input);
  };

  /** The op BODY: resolve the bound handler from the signal and run it. */
  private async invoke(input: SubscriptionDispatchInput): Promise<void> {
    const invoker = this.resolveInvoker(input.id);
    if (invoker === undefined) {
      throw new Error(`SubscriptionsHarness: no handler declared for id=${input.id}`);
    }
    await invoker(input.event, input.metadata);
  }

  /**
   * `subscriptions:dispatch` is a declared command — routed by the BaseHarness
   * command registry before this fallthrough. Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({ cause: `Unknown subscriptions message type: ${msg.type}` }),
    );
  }
}
