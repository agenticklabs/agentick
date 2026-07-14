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
  AuthorizeInput,
  AuthorizeResult,
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
  ServerTransport,
  SubscribeOptions,
  ToolDeclaration,
  ToolRegistration,
  Unsubscribe,
  WireExtension,
  WireExtensionRegistry,
  WireMethod,
} from "@agentick/spec-next";
import {
  AppAlreadyExistsError,
  DEFAULT_JOURNALING_POLICY,
  GATEWAY_CAPABILITIES_CHANGED,
  GatewayBridgeSlotOccupied,
  GatewayClosedError,
  GatewayLifecycleError,
  GatewayNotStartedError,
  toRegistration,
} from "@agentick/spec-next";
import { createWireExtensionRegistry } from "./wire-registry.js";
import { unconfiguredAuthorizer } from "./authorizers.js";
import { createCommandsListHandler, createDynamicCommandResolver } from "./dynamic-commands.js";
import {
  appWireExtension,
  gatewayWireExtension,
  sessionWireExtension,
  subscriptionsWireExtension,
} from "./wire/index.js";
import { mergeLayered } from "@agentick/utils-next";
import { AppHarness, builtinWireExtensions, type AppHarnessOptions } from "@agentick/app-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

// ADR 80/83/84 — light up the gateway lifecycle verbs. Both `gateway:start`
// (see `listen`) and `gateway:close` (see `close`) route through
// `runOperation`, so typing them mints `onBeforeGatewayStart` /
// `onAfterGatewayStart` and `onBeforeGatewayClose` / `onAfterGatewayClose` on
// the derived `CommandHooks` surface. Both ops are nullary —
// `Operation<undefined, void>` — so both sides are typed from these
// declarations. (`gateway:close` is the ADR 84 rename of `gateway:close-gateway`
// — `onGatewayClose`, dropping the redundant `Gateway` suffix.)
//
// ADR 84 §4/§5 — two more gateway ops route through `runOperation`:
//   - `gateway:create-app` (see `createApp`) mints `onBeforeGatewayCreateApp`
//     / `onAfterGatewayCreateApp`. Before-hook input is the normalized
//     `CreateGatewayAppInput` (veto by throwing, or transform for multi-tenant
//     app-mount gating); after-hook output is the mounted `AppHarnessProtocol`.
//   - `authorizer:authorize` (see `authorize`) mints
//     `onBeforeAuthorizerAuthorize` / `onAfterAuthorizerAuthorize` — the FINE
//     contextual auth layer (ADR 84 §5). Before-hook can augment the
//     `AuthorizeInput` (add contextual scopes) or throw to deny; after-hook
//     observes the `AuthorizeResult`. The structural ceiling (`requiredScopes`)
//     stays un-waivable and OUTSIDE this seam — checked before the op fires.
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "gateway:start": { input: undefined; output: void };
    "gateway:close": { input: undefined; output: void };
    "gateway:create-app": { input: CreateGatewayAppInput; output: AppHarnessProtocol };
    "authorizer:authorize": { input: AuthorizeInput; output: AuthorizeResult };
  }
}

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
  /**
   * Identity-authorization policy for the dynamic command lane (ADR 51
   * §4). Default: `unconfiguredAuthorizer` — unauthenticated callers
   * (the local pole) pass; any authenticated principal is DENIED until
   * a policy is configured (deny-by-default). Bundled:
   * `staticAuthorizer({ grants })`, `permissiveAuthorizer()`.
   */
  readonly authorizer?: import("@agentick/spec-next").Authorizer;
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

  /**
   * Server transports the gateway owns (ADR 84 §2). Each is a
   * {@link ServerTransport} whose wire config (port/path/tls) is bound at
   * its own construction; `gateway.listen()` fans out to
   * `transport.listen(this)` (injecting the gateway as the dispatch host)
   * and `gateway.close()` closes each. Flat adopter surface (the `withX`
   * convention — no `config: {}` nest).
   *
   * The concrete transport wrappers (webSocket / http / unixSocket /
   * inProcess) ship from the `@agentick/transport-*-next` packages; this
   * slot accepts any of them (or a test double). Omitted → the fan-out is
   * a no-op and `listen()` just flips ready.
   */
  readonly transports?: readonly ServerTransport[];
}

// ============================================================================
// GatewayHarness
// ============================================================================

const SURFACE = "gateway" as const;

export class GatewayHarness extends BaseHarness<typeof SURFACE> implements GatewayHarnessProtocol {
  private readonly _apps = new Map<string, AppHarnessProtocol>();
  /** ADR 51 §4 — read by the wire dispatch choke point (every method,
   *  both lanes) and by commands/list's visibility filter. */
  readonly authorizer!: import("@agentick/spec-next").Authorizer;
  private gatewayClosed = false;
  /** Idempotency latch for {@link listen} — a second `listen()` is a no-op. */
  private gatewayStarted = false;
  /**
   * Server transports this gateway owns (ADR 84 §2). Bound in {@link listen}
   * via `transport.listen(this)`, torn down in {@link closeBody} via
   * `transport.close()`. Empty when {@link GatewayHarnessOptions.transports}
   * was omitted — the fan-out is then a clean no-op.
   */
  private readonly serverTransports: readonly ServerTransport[];

  /**
   * Gateway-extension bridges (ADR 50) — the `gateway.bridges.<name>`
   * bag. Hard singleton: `registerNamespace` throws on an occupied slot.
   */
  private readonly _bridges: Record<string, unknown> = {};
  /** `onClose` handlers registered by gateway extensions (LIFO teardown). */
  private readonly gatewayExtensionCloseHandlers: Array<() => void | Promise<void>> = [];
  /**
   * Live `subscribeBus` fiber-interrupt thunks from gateway extensions.
   * Interrupted during {@link closeBody} so an extension that
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
    // `gateway:command:close` envelopes route bus-only — same Option G
    // pattern AppHarness/SessionHarness use to prevent "writing to a closed
    // journal" crashes when substrate teardown handlers fire inside
    // super.close(). `mergeLayered` deep-merges the `override` map
    // automatically; adding fields to JournalingPolicy doesn't require
    // touching this site. `gateway:start` needs NO override — it does not
    // tear down the substrate, so its envelopes journal normally.
    const policy = mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY, options.policy, {
      override: { "gateway:command:close": "bus-only" },
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

    // Own the adopter-supplied server transports (ADR 84 §2). Wire config is
    // already bound inside each transport's factory; the gateway only needs to
    // hand them itself as the dispatch host at `listen()` time.
    this.serverTransports = options.transports ?? [];

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
    // Built-in wire-extensions (knobs/set, …) — the always-present harnesses'
    // client commands. Registered in the bundled tier (not framework-privileged)
    // so an adopter may still gate or override them. `app-next` names them so
    // the gateway stays harness-agnostic (never imports a built-in directly).
    for (const ext of [
      ...(options.wireExtensions ?? []),
      ...wireFromBundles,
      ...builtinWireExtensions,
    ]) {
      this._wireExtensions.register(ext);
    }

    // ADR 51 slice 5 — the dynamic command lane. The resolver embeds
    // the Authorizer gate (deny-by-default; it NEVER ships ungated,
    // §4.3) and registers before seal. Explicit methods above shadow it
    // mechanically. `commands/list` is the runtime discovery surface.
    {
      const authorizer = options.authorizer ?? unconfiguredAuthorizer();
      this.authorizer = authorizer;
      const lane = { inbox: this.inbox, authorizer };
      this._wireExtensions.registerDynamicResolver(createDynamicCommandResolver(lane));
      this._wireExtensions.register({
        name: "@agentick/commands",
        namespace: "commands",
        methods: {
          "commands/list": createCommandsListHandler(lane),
        } as never,
      });
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
   * Route a wire (JSON-RPC) dispatch through this gateway's operation
   * seam (ADR 83 §"Wire dispatch through the seam"). The transport
   * dispatcher calls this AROUND the resolved handler so the wire
   * method fires the gateway's interceptor seam — `runOperation` runs
   * the phase contract + composed guards/hooks around `run`.
   *
   * The op name is the `wire:`-prefixed wire method (`wire:session/send`),
   * so `deriveHookNames` Pascalizes it to `WireSessionSend` and a
   * gateway-scoped `onBeforeWireSessionSend` hook fires — DISTINCT from
   * the inner `session:send` op's `onBeforeSessionSend` (ADR 83 wire
   * section, `wire:` prefix): the wire boundary and the session op are
   * separate seams, one fire each, no collision. A FRESH unique `opId`
   * (`wire:<method>:<ulid>`) guarantees the idempotency replay never
   * triggers — the pre-seam wire path had no opId at all.
   *
   * Error propagation is byte-identical to the direct call: a handler
   * rejection maps into `runOperation`'s failure channel via
   * `Effect.tryPromise`'s `catch`, `runOperation` re-raises the ORIGINAL
   * error after `terminal:failed`, and `runHarnessProtocol` rejects the
   * returned promise with it — surfacing to the dispatcher's outer
   * try/catch exactly as before.
   */
  runWireDispatch<R>(method: WireMethod, params: unknown, run: () => Promise<R>): Promise<R> {
    const op: Operation<unknown, R, unknown> = {
      opId: `wire:${method}:${ulid()}`,
      surface: SURFACE,
      // `wire:` prefix (ADR 83 wire section): the wire op name must NOT
      // collide with the op it delegates to (`session/send` vs `session:send`
      // both Pascalize to `SessionSend`). Prefixed → `WireSessionSend`, so the
      // wire boundary hook is `onBeforeWireSessionSend`, distinct from the
      // session op's `onBeforeSessionSend` (which folds down live from the
      // gateway and fires once at the session).
      name: `wire:${method}`,
      scope: { gatewayId: this.scopeId },
      input: params,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => cause,
        }),
      ),
    );
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

  async createApp<P>(
    rootElement: CreateGatewayAppInput<P>["rootElement"],
    input: Omit<CreateGatewayAppInput<P>, "rootElement">,
  ): Promise<AppHarnessProtocol<P>>;
  async createApp<P>(input: CreateGatewayAppInput<P>): Promise<AppHarnessProtocol<P>>;
  async createApp<P>(
    rootOrInput: CreateGatewayAppInput<P>["rootElement"] | CreateGatewayAppInput<P>,
    maybeInput?: Omit<CreateGatewayAppInput<P>, "rootElement">,
  ): Promise<AppHarnessProtocol<P>> {
    // Two-door signature, mirroring `createApp(rootElement, options)`: the
    // positional form is discriminated by the presence of the second arg
    // (arity), so no structural sniffing of the first is needed. Normalize
    // FIRST so the op — and its `onBeforeGatewayCreateApp` hook — always sees
    // one canonical `CreateGatewayAppInput` shape regardless of the door used.
    const input: CreateGatewayAppInput<P> =
      maybeInput === undefined
        ? (rootOrInput as CreateGatewayAppInput<P>)
        : ({
            ...maybeInput,
            rootElement: rootOrInput as CreateGatewayAppInput<P>["rootElement"],
          } as CreateGatewayAppInput<P>);

    // Lifecycle pre-gates (ADR 84 §1) — checked BEFORE the `gateway:create-app`
    // op fires, so `onBeforeGatewayCreateApp` never runs on a closed or
    // not-started gateway. Closed wins over not-started (a closed gateway is
    // terminal regardless of whether it was ever started).
    if (this.gatewayClosed) {
      throw new GatewayClosedError();
    }
    if (!this.gatewayStarted) {
      throw new GatewayNotStartedError();
    }

    // ADR 84 §4 — wrap the mount in the hookable `gateway:create-app` op via
    // `runOperation` (the same pattern `listen` / `close` mirror). The
    // before-hook (`onBeforeGatewayCreateApp`) can veto (throw) or transform
    // the normalized input (multi-tenant gating); the body receives the
    // possibly-transformed input; the after-hook (`onAfterGatewayCreateApp`)
    // observes the mounted `AppHarnessProtocol`.
    const op: Operation<CreateGatewayAppInput<P>, AppHarnessProtocol<P>, GatewayError> = {
      opId: `gateway:create-app:${ulid()}`,
      surface: SURFACE,
      name: "gateway:command:create-app",
      scope: { gatewayId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.createAppBody(i),
          // Map the rejection into the op's typed FAIL channel (NOT a defect):
          // `runHarnessProtocol` rethrows a Fail value AS-IS, so
          // `GatewayClosedError` / `AppAlreadyExistsError` keep their identity
          // (instanceof) at the caller. A bare `throw` here would become a
          // defect and get stringified — see `mapGatewayError`.
          catch: mapGatewayError,
        }),
      ),
    );
  }

  /**
   * Mount body for the {@link createApp} op (ADR 84 §4). Receives the
   * normalized — and possibly `onBeforeGatewayCreateApp`-transformed — input.
   * The `appId` default, duplicate-id check, substrate inheritance,
   * tool/extension cascade, and app registration all live here so the
   * before-hook operates on the raw input and the after-hook observes the
   * finished app. The closed/not-started lifecycle guards are pre-gates in
   * {@link createApp} (before the op fires).
   */
  private async createAppBody<P>(input: CreateGatewayAppInput<P>): Promise<AppHarnessProtocol<P>> {
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
      // ADR 84 §3 — the CAPSTONE live link: the app registers as a live
      // interceptor child of this gateway. A hook/guard/use registered on the
      // gateway AFTER the app (and its sessions) exist folds down live through
      // the whole chain gateway → app → session → sub-harnesses. This is the
      // top edge of the ADR 83 §4 uniform cascade, not a special case.
      interceptorParent: this,
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

  /**
   * Bind the gateway's server transports and flip ready (ADR 84 §1). The
   * canonical server `listen()` — pairs with {@link close}. Runs as the
   * hookable `gateway:start` op through `runOperation`, so a gateway
   * `onBeforeGatewayStart` guard can gate/feature-flag transports and an
   * `onAfterGatewayStart` observer can log bound addresses.
   *
   * Idempotent: a second call is a safe no-op (the started-latch short-circuits
   * before the op fires, so owned transports are NOT re-listened). Fans out to
   * every owned {@link ServerTransport} via `transport.listen(this)`, injecting
   * the gateway as the dispatch host (ADR 84 §2). Zero transports → the fan-out
   * is a no-op that just flips ready.
   *
   * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md
   */
  listen(): Promise<void> {
    if (this.gatewayStarted) {
      return Promise.resolve();
    }
    this.gatewayStarted = true;
    const op: Operation<undefined, void, never> = {
      opId: `gateway:start:${ulid()}`,
      surface: SURFACE,
      name: "gateway:command:start",
      scope: { gatewayId: this.scopeId },
      input: undefined,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: () => this.listenBody(),
          catch: (cause): never => {
            throw cause;
          },
        }),
      ),
    );
  }

  /**
   * Terminal teardown (ADR 84 §1) — symmetric with {@link listen}. The SOLE
   * terminal verb, gaining the graceful-vs-forced `{ drain }` argument:
   * `close({ drain: false })` is the forced variant. Drain-by-default. There is
   * deliberately NO `destroy()` twin — graceful-vs-forced is a parameter, not a
   * second verb (ADR 84 §1). Idempotent: a second call is a safe no-op.
   */
  close(opts: { drain?: boolean } = {}): Promise<void> {
    if (this.gatewayClosed) {
      return Promise.resolve();
    }
    this.gatewayClosed = true;
    const drain = opts.drain ?? true;
    // ADR 51 classification: serializable (no input) — a declared-
    // command candidate; exposure is a verb-matrix decision (remote
    // gateway shutdown) deferred with slice 5.
    const op: Operation<undefined, void, never> = {
      opId: `gateway:close:${ulid()}`,
      surface: SURFACE,
      name: "gateway:command:close",
      scope: { gatewayId: this.scopeId },
      input: undefined,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: () => this.closeBody(drain),
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

  /**
   * The FINE contextual authorization layer (ADR 84 §5). Wraps
   * {@link authorizer}.authorize in the hookable `authorizer:authorize` op via
   * `runOperation`, so `onBeforeAuthorizerAuthorize` can augment the
   * {@link AuthorizeInput} from request context (grant a contextual scope) or
   * throw to deny, and `onAfterAuthorizerAuthorize` can observe/audit the
   * {@link AuthorizeResult}. The wire dispatch gate (`authorizeDispatch`)
   * routes its policy calls through THIS method rather than the raw authorizer.
   *
   * CRITICAL: the STRUCTURAL ceiling (`SessionHarnessProtocol.requiredScopes`)
   * stays un-waivable and OUTSIDE this seam — `authorizeDispatch` checks it
   * BEFORE this op fires, so no hook here can widen it. This op is only the
   * policy layer that sits ON TOP of that floor.
   */
  authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const op: Operation<AuthorizeInput, AuthorizeResult, never> = {
      opId: `authorizer:authorize:${ulid()}`,
      surface: SURFACE,
      name: "authorizer:command:authorize",
      scope: { gatewayId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: () => this.authorizer.authorize(i),
          catch: (cause): never => {
            throw cause;
          },
        }),
      ),
    );
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

  /**
   * Start-op body (ADR 84 §1 + §2). Ensures the gateway is ready, then fans
   * out to every owned {@link ServerTransport}, binding each with the gateway
   * as its dispatch host. Ready is awaited FIRST so the wire registry has
   * sealed before any transport begins accepting frames it would route back
   * through this host. Zero transports → the fan-out is a clean no-op.
   */
  private async listenBody(): Promise<void> {
    await this.gatewayReady;
    await Promise.all(this.serverTransports.map((t) => t.listen(this)));
  }

  private async closeBody(drain: boolean): Promise<void> {
    // The `ServerTransport` fan-out now exists (below), but the ADR 84 §2
    // interface is `close(): Promise<void>` — deliberately NO `drain` arg.
    // Graceful-vs-forced at the transport level (`drain === false` ⇒ stop
    // accepting immediately, skip the in-flight drain) is a concrete-wrapper
    // concern, so the flag is accepted at the gateway edge but not yet
    // threaded down.
    // TODO(adr-84): when the concrete transport wrappers land, either widen
    // `ServerTransport.close(opts?: { drain })` or add a `drain()` verb, and
    // pass `drain` through here.
    void drain;
    // Close server transports FIRST (ADR 84 §2) — before any app teardown.
    // Transports are the ingress edge: an inbound frame routes through
    // `dispatchRequest(this, …)` into an app/session. Tearing an app down while
    // its transport still accepts frames races a half-closed app against live
    // dispatch. Stopping ingress first quiesces the deployment top-down (the
    // mirror of `listen`, which binds transports LAST, after ready) — so the
    // LIFO close order is: transports → apps → extensions → substrate.
    await Promise.all(
      this.serverTransports.map(async (t) => {
        try {
          await t.close();
        } catch {
          // Best effort — one transport's close failure must not block the
          // rest of teardown (apps, extensions, substrate still must close).
        }
      }),
    );

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
   * teardown). Fired LIFO during {@link closeBody}, AFTER apps
   * close and BEFORE substrate teardown via `super.close()`.
   */
  private readonly internalCloseHandlers: Array<() => void | Promise<void>> = [];

  /**
   * Register a close handler that fires during {@link close},
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
// Error mapping
// ============================================================================

/**
 * Map a `createApp` rejection into the op's typed `GatewayError` FAIL channel
 * (the twin of `@agentick/app-next`'s `mapAppError`). A typed `AgentickError`
 * (carrying a string `_tag`) — `GatewayClosedError`, `AppAlreadyExistsError`,
 * etc. — passes through AS-IS so `runHarnessProtocol` rethrows it with its
 * identity intact (pattern-match / `instanceof` at the caller). Anything else
 * (a raw throw from an `onBeforeGatewayCreateApp` hook, say) is wrapped as a
 * `GatewayLifecycleError` so the channel stays typed.
 */
function mapGatewayError(cause: unknown): GatewayError {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag?: unknown })._tag === "string"
  ) {
    return cause as GatewayError;
  }
  return new GatewayLifecycleError({ cause });
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
