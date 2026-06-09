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
  runHarnessProtocol,
  ulid,
  type BaseHarnessOptions,
} from "@agentick/runtime-next";
import type {
  AppHarnessProtocol,
  CreateAppInput,
  EventBus,
  EventBusFactory,
  EventQuery,
  GatewayError,
  GatewayHarnessProtocol,
  GatewaySubstrateParent,
  JournalingPolicy,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MessageInboxFactory,
  Operation,
  OperationJournal,
  OperationJournalFactory,
  ProtocolEvent,
  SubscribeOptions,
} from "@agentick/spec-next";
import { DEFAULT_JOURNALING_POLICY } from "@agentick/spec-next";
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
export interface CreateGatewayAppInput<P = unknown>
  extends Omit<CreateAppInput<P>, "options"> {
  /**
   * App construction options sans `rootElement` (supplied separately
   * on this input) and sans `appId` (supplied at the gateway level).
   */
  readonly options: Omit<AppHarnessOptions<P>, "rootElement" | "appId">;
}

export interface GatewayHarnessOptions extends BaseHarnessOptions {
  /** Stable gateway id; defaults to `gateway:${ulid()}`. */
  readonly gatewayId?: string;
}

// ============================================================================
// GatewayHarness
// ============================================================================

const SURFACE = "gateway" as const;

type GatewayInboxMessage = {
  readonly type: "gateway:noop";
  readonly payload: undefined;
};

export class GatewayHarness
  extends BaseHarness<typeof SURFACE>
  implements GatewayHarnessProtocol
{
  private readonly _apps = new Map<string, AppHarnessProtocol>();
  private gatewayClosed = false;

  get id(): string {
    return this.scopeId;
  }

  constructor(options: GatewayHarnessOptions = {}) {
    const gatewayId = options.gatewayId ?? `gateway:${ulid()}`;
    const journal = options.journal instanceof Function ? undefined : (options.journal as OperationJournal | undefined);
    const bus = options.bus instanceof Function ? undefined : (options.bus as EventBus | undefined);
    const inbox = options.inbox instanceof Function ? undefined : (options.inbox as MessageInbox | undefined);

    // Merge close-op policy override into adopter-supplied policy.
    // `gateway:command:close-gateway` envelopes route bus-only — same
    // Option G pattern AppHarness/SessionHarness use to prevent
    // "writing to a closed journal" crashes when substrate teardown
    // handlers fire inside super.close().
    const basePolicy: JournalingPolicy = options.policy ?? DEFAULT_JOURNALING_POLICY;
    const policy: JournalingPolicy = {
      ...basePolicy,
      override: {
        ...(basePolicy.override ?? {}),
        "gateway:command:close-gateway": "bus-only",
      },
    };

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

  events(
    filter: EventQuery = {},
    options: SubscribeOptions = {},
  ): AsyncIterable<ProtocolEvent> {
    const bus = this.bus;
    return {
      [Symbol.asyncIterator]: () => makeBusAsyncIterator(bus, filter, options),
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

    // Substrate close handlers registered via BaseHarness.onClose run
    // through the standard BaseHarness.close() path.
    await super.close();
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

// ============================================================================
// Async-iterator bridge (matches AppHarness.events shape)
// ============================================================================

function makeBusAsyncIterator(
  bus: EventBus,
  query: EventQuery,
  options: SubscribeOptions = {},
): AsyncIterator<ProtocolEvent> {
  // Effect-typed Stream → AsyncIterator. Identical to the helper in
  // @agentick/app-next/harness.ts. Keeping local rather than re-exporting
  // because the helper is small and an internal concern.
  const { Effect: Eff, Fiber, Stream } = require("effect") as typeof import("effect");
  const stream = bus.subscribe(query, options);
  const queue: ProtocolEvent[] = [];
  const resolvers: Array<(r: IteratorResult<ProtocolEvent>) => void> = [];
  let done = false;
  let error: unknown = null;

  const fiber = Eff.runFork(
    Stream.runForEach(stream, (event) =>
      Eff.sync(() => {
        if (done) return;
        const r = resolvers.shift();
        if (r) r({ value: event, done: false });
        else queue.push(event);
      }),
    ).pipe(
      Eff.catchAll((e) =>
        Eff.sync(() => {
          error = e;
          done = true;
          for (const r of resolvers.splice(0)) {
            r({ value: undefined as unknown as ProtocolEvent, done: true });
          }
        }),
      ),
      Eff.tap(() =>
        Eff.sync(() => {
          done = true;
          for (const r of resolvers.splice(0)) {
            r({ value: undefined as unknown as ProtocolEvent, done: true });
          }
        }),
      ),
    ),
  );

  return {
    next(): Promise<IteratorResult<ProtocolEvent>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (done) {
        if (error) return Promise.reject(error);
        return Promise.resolve({ value: undefined as unknown as ProtocolEvent, done: true });
      }
      return new Promise((resolve) => resolvers.push(resolve));
    },
    return(): Promise<IteratorResult<ProtocolEvent>> {
      done = true;
      Eff.runFork(Fiber.interrupt(fiber));
      return Promise.resolve({ value: undefined as unknown as ProtocolEvent, done: true });
    },
  };
}
