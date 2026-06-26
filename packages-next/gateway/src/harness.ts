/**
 * `GatewayHarness` — top-level harness in the v2 hierarchy.
 *
 * Per ADR 31 + `blueprint/12-gateway.md`, Gateway is the **runtime
 * root**: owns the top-level substrate (bus/inbox/journal) Apps below
 * inherit or wrap, hosts one or more Apps, is the lifecycle root.
 *
 * Useful in every deployment tier — local single-user agents
 * (OpenClaw / Hermes style), single-tenant cloud, multi-tenant
 * distributed cloud. Network transports, plugins, auth are
 * extensions; the core harness ships only the runtime-root surface.
 *
 * Phase 4 deliverable — Tier 0 only (in-process; no transports;
 * no plugins; no auth). Cluster substrate, transports, plugins land
 * in Phase 5+ as their own packages.
 *
 * @see docs/proposals/v2/blueprint/12-gateway.md
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
 * @see docs/proposals/v2/V1-GATEWAY-PARITY-TRACKER.md
 */

import { Effect } from "effect";
import {
  BaseHarness,
  busAsyncIterator,
  runHarnessProtocol,
  ulid,
  type BaseHarnessOptions,
} from "@agentick/runtime-next";
import type {
  AppHarnessProtocol,
  CreateAppInput,
  EventBus,
  EventQuery,
  GatewayError,
  GatewayHarnessProtocol,
  JournalingPolicy,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  ProtocolEvent,
  SubscribeOptions,
  ToolDeclaration,
  ToolRegistration,
} from "@agentick/spec-next";
import { DEFAULT_JOURNALING_POLICY, toRegistration } from "@agentick/spec-next";
import { mergeLayered } from "@agentick/utils-next";
import { AppHarness, type AppHarnessOptions } from "@agentick/app-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

// ============================================================================
// Options
// ============================================================================

/**
 * Concrete `CreateAppInput` typed against `@agentick/app-next`'s
 * `AppHarnessOptions<P>`. The spec's `CreateAppInput<P>` keeps
 * `options` opaque (no App-package dep in spec); this alias narrows
 * to the real shape at the gateway impl boundary.
 */
export interface CreateGatewayAppInput<P = unknown> extends Omit<CreateAppInput<P>, "options"> {
  /**
   * App construction options sans `rootElement` (supplied separately
   * on this input) and sans `appId` (supplied at the gateway level).
   */
  readonly options: Omit<AppHarnessOptions<P>, "rootElement" | "appId">;
}

export interface GatewayHarnessOptions extends BaseHarnessOptions {
  /** Stable gateway id; defaults to `gateway:${ulid()}`. */
  readonly gatewayId?: string;
  /**
   * Gateway-level tool declarations (layered config). Every app
   * hosted by this gateway sees these tools in every session, tagged
   * with `binding: { scope: "gateway" }`.
   *
   * The lowest non-`runtime` rung in the precedence ladder — every
   * app/session/execution/extension/reconciler-scoped tool overrides
   * gateway-bound tools on name collision. Use this for absolute
   * baseline tools every agent in the process should reach for
   * (e.g., process-wide health-check or telemetry tools).
   *
   * Propagation: `createApp` pre-tags these as `ToolRegistration[]`
   * with gateway binding and threads them through
   * `AppHarnessOptions.inheritedTools`. Adopters who supply a custom
   * `ToolExecutorFactory` on an app bypass the bundled registry and
   * MUST thread these tools themselves.
   *
   * @see ToolBinding in `@agentick/spec-next` for the precedence ladder.
   */
  readonly tools?: ReadonlyArray<ToolDeclaration>;
}

// ============================================================================
// GatewayHarness
// ============================================================================

const SURFACE = "gateway" as const;

export class GatewayHarness extends BaseHarness<typeof SURFACE> implements GatewayHarnessProtocol {
  private readonly _apps = new Map<string, AppHarnessProtocol>();
  private gatewayClosed = false;
  /**
   * Gateway-level tool registrations, pre-tagged with
   * `binding: { scope: "gateway" }`. Forwarded to every app via
   * `AppHarnessOptions.inheritedTools`. Empty when
   * `GatewayHarnessOptions.tools` was omitted.
   */
  private readonly gatewayTools: readonly ToolRegistration[];

  get id(): string {
    return this.scopeId;
  }

  constructor(options: GatewayHarnessOptions = {}) {
    const gatewayId = options.gatewayId ?? `gateway:${ulid()}`;
    const journal =
      options.journal instanceof Function
        ? undefined
        : (options.journal as OperationJournal | undefined);
    const bus = options.bus instanceof Function ? undefined : (options.bus as EventBus | undefined);
    const inbox =
      options.inbox instanceof Function ? undefined : (options.inbox as MessageInbox | undefined);

    // Merge close-op policy override into adopter-supplied policy.
    // `gateway:command:close-gateway` envelopes route bus-only — same
    // Option G pattern AppHarness/SessionHarness use to prevent
    // "writing to a closed journal" crashes when substrate teardown
    // handlers fire inside super.close(). `mergeLayered` deep-merges
    // the `override` map automatically; adding fields to
    // JournalingPolicy doesn't require touching this site.
    const policy = mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY, options.policy, {
      override: { "gateway:command:close-gateway": "bus-only" },
    });

    super(
      SURFACE,
      gatewayId,
      journal ?? new MemoryJournal(),
      bus ?? new LocalEventBus(),
      inbox ?? new LocalInbox(),
      {
        ...options,
        policy,
      },
    );

    // Pre-tag gateway-level tools once at construction. Every
    // `createApp` call threads this same array through to the new
    // app via `AppHarnessOptions.inheritedTools`.
    this.gatewayTools = (options.tools ?? []).map((decl) =>
      toRegistration(decl, { scope: "gateway" }),
    );
  }

  // ============================================================================
  // GatewayHarnessProtocol
  // ============================================================================

  app(appId: string): AppHarnessProtocol | undefined {
    return this._apps.get(appId);
  }

  apps(): readonly AppHarnessProtocol[] {
    return Array.from(this._apps.values());
  }

  async createApp<P>(input: CreateGatewayAppInput<P>): Promise<AppHarnessProtocol<P>> {
    if (this.gatewayClosed) {
      const err: GatewayError = { _tag: "GatewayClosedError" };
      throw err;
    }
    const appId = input.appId ?? `app:${ulid()}`;
    if (this._apps.has(appId)) {
      const err: GatewayError = { _tag: "AppAlreadyExistsError", appId };
      throw err;
    }

    // Default substrate slots to Gateway's substrate (instance form —
    // no per-app wrapping unless adopter explicitly passes factories).
    // Factory overrides at input.bus/inbox/journal flow through
    // unchanged.
    const bus = input.bus ?? this.bus;
    const inbox = input.inbox ?? this.inbox;
    const journal = input.journal ?? this.journal;

    // Merge gateway-propagated tools with any inheritedTools the
    // adopter explicitly passed (adopter-supplied takes second
    // position; both arrays carry their own bindings so merging is
    // just concatenation — precedence resolves at compileForTick).
    const inheritedTools: readonly ToolRegistration[] =
      this.gatewayTools.length > 0 || (input.options.inheritedTools?.length ?? 0) > 0
        ? [...this.gatewayTools, ...(input.options.inheritedTools ?? [])]
        : [];

    const appOptions: AppHarnessOptions<P> = {
      ...input.options,
      appId,
      rootElement: input.rootElement,
      // Substrate at the App slot — see AppHarnessOptions.bus/inbox/journal.
      // Cast tolerated here because the spec's parent typing differs
      // (GatewaySubstrateParent vs the AppHarness's installer-substrate
      // shape); both are structurally compatible at the BaseHarness
      // slot resolution layer.
      bus: bus as AppHarnessOptions<P>["bus"],
      inbox: inbox as AppHarnessOptions<P>["inbox"],
      journal: journal as AppHarnessOptions<P>["journal"],
      ...(inheritedTools.length > 0 ? { inheritedTools } : {}),
    };

    const app = new AppHarness<P>(appOptions);
    await app.appReady;

    this._apps.set(appId, app);

    // Surface app construction on the gateway bus for observers.
    void Effect.runPromise(
      this.bus.append({
        id: `evt_${ulid()}`,
        surface: SURFACE,
        name: "gateway:app:created",
        phase: "terminal",
        outcome: "succeeded",
        timestamp: Date.now(),
        scope: { gatewayId: this.scopeId, appId },
        payload: { metadata: input.metadata ?? {} },
      } as ProtocolEvent),
    );

    return app;
  }

  closeGateway(): Promise<void> {
    if (this.gatewayClosed) {
      return Promise.resolve();
    }
    this.gatewayClosed = true;
    const op: Operation<undefined, void, never> = {
      opId: `gateway:close:${ulid()}`,
      surface: SURFACE,
      name: "gateway:command:close-gateway",
      scope: { gatewayId: this.scopeId },
      input: undefined,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: () => this.closeGatewayBody(),
          catch: (cause): never => {
            // Rethrow as plain — Effect's failure channel for the
            // close body is unconstrained; we surface the underlying
            // error.
            throw cause;
          },
        }),
      ),
    );
  }

  close(): Promise<void> {
    return this.closeGateway();
  }

  events(filter: EventQuery = {}, options: SubscribeOptions = {}): AsyncIterable<ProtocolEvent> {
    const bus = this.bus;
    return {
      [Symbol.asyncIterator]: () => busAsyncIterator(bus, filter, options),
    };
  }

  // ============================================================================
  // Lifecycle helpers
  // ============================================================================

  private async closeGatewayBody(): Promise<void> {
    // Close every registered App. Each App's close cascades into its
    // sessions; we await sequentially to preserve teardown ordering.
    const apps = Array.from(this._apps.values());
    for (const app of apps) {
      try {
        await app.closeApp();
      } catch {
        // Tolerate per-app close failures; continue closing the rest.
      }
    }
    this._apps.clear();

    // Run internal close handlers (cluster wrappers, etc) in reverse
    // registration order. After apps close (so cluster wrappers see
    // their final outbound writes), before super.close() (which tears
    // down the substrate the cluster wrapped).
    for (const handler of this.internalCloseHandlers.slice().reverse()) {
      try {
        await handler();
      } catch {
        // best effort
      }
    }

    // Substrate close handlers registered via BaseHarness.onClose run
    // through the standard BaseHarness.close() path.
    await super.close();
  }

  /**
   * Close handlers registered by `createGateway` (e.g., for cluster
   * teardown). Fired LIFO during {@link closeGatewayBody}, AFTER apps
   * close and BEFORE substrate teardown via `super.close()`.
   */
  private readonly internalCloseHandlers: Array<() => void | Promise<void>> = [];

  /**
   * Register a close handler that fires during {@link closeGateway},
   * AFTER all spawned apps close and BEFORE the substrate teardown.
   *
   * Internal slot used by `createGateway` to wire substrate-level
   * lifecycle (e.g., closing a `cluster` that wrapped the local
   * bus/inbox/journal). Adopters should NOT call this directly.
   *
   * Handler errors are swallowed (best-effort teardown).
   */
  addInternalCloseHandler(handler: () => void | Promise<void>): void {
    this.internalCloseHandlers.push(handler);
  }

  // ============================================================================
  // Inbox (BaseHarness requirement)
  // ============================================================================

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // Gateway has no first-class inbox messages today. Extensions may
    // wire their own through `registerNamespace` + their own routing.
    void msg;
    return Effect.succeed(undefined);
  }
}
