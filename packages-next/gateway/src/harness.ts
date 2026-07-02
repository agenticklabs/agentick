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
  forkBusSubscription,
  runHarnessProtocol,
  ulid,
  type BaseHarnessOptions,
} from "@agentick/runtime-next";
import type {
  AnyExtension,
  AppHarnessProtocol,
  CreateAppInput,
  EventBus,
  EventQuery,
  Extension,
  ExtensionBundle,
  GatewayBridges,
  GatewayError,
  GatewayExtension,
  GatewayHarnessProtocol,
  GatewayInstaller,
  GatewayInstallerHost,
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
  Unsubscribe,
  WireExtension,
  WireExtensionRegistry,
} from "@agentick/spec-next";
import {
  AppAlreadyExistsError,
  DEFAULT_JOURNALING_POLICY,
  GATEWAY_CAPABILITIES_CHANGED,
  GatewayBridgeSlotOccupied,
  GatewayClosedError,
  toRegistration,
} from "@agentick/spec-next";
import { createWireExtensionRegistry } from "./wire-registry.js";
import {
  appWireExtension,
  gatewayWireExtension,
  sessionWireExtension,
  subscriptionsWireExtension,
} from "./wire/index.js";
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

  /**
   * Adopter-supplied wire extensions (ADR 46) installed on this
   * gateway. Each contributes a JSON-RPC namespace (`crm/*`,
   * `myOrg/*`, ...) that the wire dispatcher can route to. Package
   * self-install (`withMCP(...)` returning a composite extension
   * with a `wire` slot) will layer on top of this in Phase E.
   *
   * The registry is sealed once `gateway.ready` resolves — extensions
   * cannot be registered post-hoc.
   */
  readonly wireExtensions?: ReadonlyArray<WireExtension>;

  /**
   * Gateway + composite extensions (ADR 50). Accepts bare
   * {@link GatewayExtension} / {@link AppExtension} /
   * {@link SessionExtension}, or {@link ExtensionBundle} composites.
   * Distribution:
   *   - `gateway` parts install during gateway construction (before the
   *     wire registry seals);
   *   - `wire` parts register into the ADR 46 registry now;
   *   - `app` / `session` parts become cascaded defaults for every
   *     `gateway.createApp` / `createSession` beneath this gateway
   *     (composed BEFORE per-call extensions).
   *
   * Distinct from {@link wireExtensions} (raw wire-extension array) —
   * this is the higher-level extension surface. Both may be supplied.
   */
  readonly extensions?: ReadonlyArray<AnyExtension>;
}

// ============================================================================
// GatewayHarness
// ============================================================================

const SURFACE = "gateway" as const;

export class GatewayHarness extends BaseHarness<typeof SURFACE> implements GatewayHarnessProtocol {
  private readonly _apps = new Map<string, AppHarnessProtocol>();
  private gatewayClosed = false;

  /**
   * Gateway-extension bridges (ADR 50) — the `gateway.bridges.<name>`
   * bag. Hard singleton: `registerNamespace` throws on an occupied slot.
   */
  private readonly _bridges: Record<string, unknown> = {};
  /** `onClose` handlers registered by gateway extensions (LIFO teardown). */
  private readonly gatewayExtensionCloseHandlers: Array<() => void | Promise<void>> = [];
  /**
   * Live `subscribeBus` fiber-interrupt thunks from gateway extensions.
   * Interrupted during {@link closeGatewayBody} so an extension that
   * subscribed but never unsubscribed doesn't leak a fiber past teardown.
   * Manual unsubscribe splices its own entry out.
   */
  private readonly gatewayExtensionBusUnsubs: Array<() => void> = [];
  /**
   * App/session extension parts cascaded from gateway-level bundles to
   * every `createApp` / `createSession` beneath (composed before
   * per-call extensions).
   */
  private readonly cascadeExtensions: readonly Extension[];
  /**
   * Resolves once every gateway-target extension has finished
   * `install()` and the wire registry has sealed. `Promise.resolve()`
   * when no gateway extensions were supplied (seal happened
   * synchronously in the constructor). Awaited via {@link gatewayReady}.
   */
  private readonly gatewayExtensionsReady: Promise<void>;
  /**
   * Gateway-level tool registrations, pre-tagged with
   * `binding: { scope: "gateway" }`. Forwarded to every app via
   * `AppHarnessOptions.inheritedTools`. Empty when
   * `GatewayHarnessOptions.tools` was omitted.
   */
  private readonly gatewayTools: readonly ToolRegistration[];
  /**
   * Wire-extension registry built at construction from
   * {@link GatewayHarnessOptions.wireExtensions}. Sealed once
   * `super.ready` resolves. The transport dispatcher reads it via
   * {@link wireExtensions} to route incoming JSON-RPC frames.
   */
  private readonly _wireExtensions: WireExtensionRegistry;

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

    // Distribute the ADR 50 extension surface into its scopes.
    const { gatewayExts, wireFromBundles, cascade } = splitExtensions(options.extensions ?? []);
    this.cascadeExtensions = cascade;

    // Build the wire-extension registry. Framework-supplied extensions
    // register FIRST — adopter attempts to claim `gateway` / `app` /
    // `session` namespaces then fail at construction with a clear
    // conflict error instead of silently shadowing framework methods.
    // Adopter raw wire extensions + bundle `wire` parts register after.
    this._wireExtensions = createWireExtensionRegistry();
    for (const ext of [
      gatewayWireExtension,
      appWireExtension,
      sessionWireExtension,
      subscriptionsWireExtension,
    ]) {
      this._wireExtensions.register(ext);
    }
    for (const ext of [...(options.wireExtensions ?? []), ...wireFromBundles]) {
      this._wireExtensions.register(ext);
    }

    // Seal timing: with no gateway extensions, seal synchronously (the
    // pre-ADR-50 path — zero behavior change). With gateway extensions,
    // their async `install()` may call `registerWireExtension`, so seal
    // is deferred until after the install phase — awaited via
    // `gatewayReady`.
    if (gatewayExts.length === 0) {
      this._wireExtensions.seal();
      this.gatewayExtensionsReady = Promise.resolve();
    } else {
      const registry = this._wireExtensions;
      this.gatewayExtensionsReady = (async () => {
        const installer = this.makeGatewayInstaller();
        // Seal in `finally`: even if an extension's `install()` throws,
        // the registry must not be left half-sealed (which would let a
        // later `registerWireExtension` mutate a registry belonging to a
        // failed gateway). The rejection still propagates through
        // `gatewayReady`, failing `createGateway` — no partial gateway.
        try {
          for (const ext of gatewayExts) {
            await ext.install(installer);
          }
        } finally {
          registry.seal();
        }
      })();
    }
  }

  /**
   * Resolves once base construction AND gateway-extension installs are
   * complete (and the wire registry has sealed). `createGateway` awaits
   * this; direct constructors that install gateway extensions must too
   * before reading `wireExtensions()` / `bridges`.
   */
  get gatewayReady(): Promise<void> {
    return Promise.all([this.ready, this.gatewayExtensionsReady]).then(() => {});
  }

  /**
   * Gateway-extension bridges (ADR 50) — `gateway.bridges.<name>`.
   * Typed via {@link GatewayBridges} module augmentation.
   */
  get bridges(): Readonly<GatewayBridges> {
    return this._bridges as Readonly<GatewayBridges>;
  }

  /** Build the {@link GatewayInstaller} handed to each gateway extension. */
  private makeGatewayInstaller(): GatewayInstaller {
    const self = this;
    const host: GatewayInstallerHost = {
      gatewayId: this.scopeId,
      metadata: this.metadata,
      apps: () => Array.from(self._apps.values()),
    };
    return {
      kind: "gateway",
      hostId: this.scopeId,
      substrate: { journal: this.journal, bus: this.bus, inbox: this.inbox },
      gateway: host,
      registerNamespace(name, value): Unsubscribe {
        if (Object.prototype.hasOwnProperty.call(self._bridges, name)) {
          throw new GatewayBridgeSlotOccupied({ slot: String(name) });
        }
        self._bridges[name as string] = value;
        return () => {
          delete self._bridges[name as string];
        };
      },
      getNamespace<T>(name: string): T | undefined {
        return self._bridges[name] as T | undefined;
      },
      registerWireExtension(extension: WireExtension): void {
        // Throws via the registry if already sealed (post-ready) — the
        // ADR 46 sealed-registry rule, reused verbatim.
        self._wireExtensions.register(extension);
      },
      subscribeBus(filter, listener): Unsubscribe {
        // forkBusSubscription = shared fork/interrupt semantics
        // (per-event error isolation baked in — the hand-rolled copy
        // here once shipped the Effect.promise fiber-killing defect).
        // The gatewayExtensionBusUnsubs tracking (close-time teardown
        // for subscriptions the extension never unsubscribed) stays a
        // gateway concern.
        const unreg = forkBusSubscription(self.bus, filter, listener);
        self.gatewayExtensionBusUnsubs.push(unreg);
        return () => {
          const idx = self.gatewayExtensionBusUnsubs.indexOf(unreg);
          if (idx >= 0) self.gatewayExtensionBusUnsubs.splice(idx, 1);
          unreg();
        };
      },
      onClose(handler): void {
        self.gatewayExtensionCloseHandlers.push(handler);
      },
    };
  }

  /**
   * Gateway-side wire-extension registry (ADR 46). The transport
   * dispatcher consults this to route incoming JSON-RPC frames to
   * extension-registered handlers before falling back to the
   * hardcoded built-in switch.
   */
  wireExtensions(): WireExtensionRegistry {
    return this._wireExtensions;
  }

  /**
   * Emit the control-plane "wire-extension set changed" signal
   * (ADR 47). Appends a {@link GATEWAY_CAPABILITIES_CHANGED} event to
   * the gateway bus on the gateway scope. Clients subscribed to the
   * gateway control-plane scope (every `@agentick/client-next` on
   * connect) receive it via `notifications/subscription/event` and
   * refetch `_extensions/list`.
   *
   * This is the bus-native replacement for the ripped-out `notify`
   * fan-out. Delivery, replay, reconnect-resume, and per-instance
   * (per-tenant / per-principal child bus) isolation are the bus's
   * job — not a bespoke connection registry with a runtime filter.
   *
   * #308 (dynamic wire extensions) is the primary caller. Fire it
   * after mutating the extension set.
   */
  emitCapabilitiesChanged(): void {
    void Effect.runPromise(
      this.bus.append({
        id: `evt_${ulid()}`,
        surface: SURFACE,
        name: GATEWAY_CAPABILITIES_CHANGED,
        phase: "terminal",
        outcome: "succeeded",
        timestamp: Date.now(),
        scope: { gatewayId: this.scopeId },
        payload: {},
      } as ProtocolEvent),
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
      const err: GatewayError = new GatewayClosedError();
      throw err;
    }
    const appId = input.appId ?? `app:${ulid()}`;
    if (this._apps.has(appId)) {
      throw new AppAlreadyExistsError({ appId });
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

    // Cascade gateway-level app/session extension parts (ADR 50) BEFORE
    // the app's own — outer scope composes first; the app filters by
    // target and forwards `session` parts to each session it creates.
    const cascadedExtensions =
      this.cascadeExtensions.length > 0
        ? [...this.cascadeExtensions, ...(input.options.extensions ?? [])]
        : input.options.extensions;

    const appOptions: AppHarnessOptions<P> = {
      ...input.options,
      appId,
      rootElement: input.rootElement,
      ...(cascadedExtensions !== undefined ? { extensions: cascadedExtensions } : {}),
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
    // ADR 51 classification: serializable (no input) — a declared-
    // command candidate; exposure is a verb-matrix decision (remote
    // gateway shutdown) deferred with slice 5.
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

    // Gateway-extension `onClose` handlers, reverse install order
    // (ADR 50) — after apps close, before the cluster/internal handlers.
    for (const handler of this.gatewayExtensionCloseHandlers.slice().reverse()) {
      try {
        await handler();
      } catch {
        // best effort — one extension's teardown failure must not block others
      }
    }

    // Interrupt any `subscribeBus` fibers the extensions left open (never
    // unsubscribed). After their onClose handlers ran, so a handler that
    // wants to observe final events still can.
    for (const unreg of this.gatewayExtensionBusUnsubs.slice()) {
      try {
        unreg();
      } catch {
        // best effort
      }
    }
    this.gatewayExtensionBusUnsubs.length = 0;

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

// ============================================================================
// Extension distribution (ADR 50)
// ============================================================================

/** Is `x` an {@link ExtensionBundle} (composite) vs a bare extension? */
function isBundle(x: AnyExtension): x is ExtensionBundle {
  // Bundles have no `target`; bare extensions always do.
  return !("target" in x);
}

/**
 * Split the `extensions` array into its scopes:
 *   - `gatewayExts`     — install during gateway construction
 *   - `wireFromBundles` — register into the wire registry now
 *   - `cascade`         — app/session parts, defaults for every createApp
 *
 * A bare {@link GatewayExtension} is a gateway part; bare app/session
 * extensions cascade; a bundle's parts distribute by field.
 */
function splitExtensions(extensions: readonly AnyExtension[]): {
  readonly gatewayExts: readonly GatewayExtension[];
  readonly wireFromBundles: readonly WireExtension[];
  readonly cascade: readonly Extension[];
} {
  const gatewayExts: GatewayExtension[] = [];
  const wireFromBundles: WireExtension[] = [];
  const cascade: Extension[] = [];

  for (const ext of extensions) {
    if (isBundle(ext)) {
      if (ext.gateway) gatewayExts.push(ext.gateway);
      if (ext.wire) wireFromBundles.push(...ext.wire);
      if (ext.app) cascade.push(ext.app);
      if (ext.session) cascade.push(ext.session);
      continue;
    }
    if (ext.target === "gateway") gatewayExts.push(ext);
    else cascade.push(ext); // app | session — cascade to createApp
  }

  return { gatewayExts, wireFromBundles, cascade };
}
