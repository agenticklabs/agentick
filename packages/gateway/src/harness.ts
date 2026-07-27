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

import { Effect, type ManagedRuntime } from "effect";
import {
  annotateOperationSpan,
  BaseHarness,
  busAsyncIterator,
  forkBusSubscription,
  getContext,
  liftMiddleware,
  runHarnessProtocol,
  scopeToCommand,
  signalFromVerdict,
  tagInterceptor,
  ulid,
  withCallMiddleware,
  type AsyncMiddleware,
  type BaseHarnessOptions,
} from "@agentick/runtime";
import type {
  AnyExtension,
  AppHarnessProtocol,
  AuthorizeInput,
  AuthorizeResult,
  ConnectionInfo,
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
  IngressAdmissionFailure,
  Middleware,
  Operation,
  OperationJournal,
  ProtocolEvent,
  ServerTransport,
  SubscribeOptions,
  TelemetrySetting,
  ToolDeclaration,
  ToolRegistration,
  Unsubscribe,
  WireExtension,
  WireExtensionContext,
  WireExtensionRegistry,
  WireGuard,
  WireMethod,
  WireMiddleware,
  WireOpConfig,
  WireParams,
  WireResult,
} from "@agentick/spec";
import {
  AppAlreadyExistsError,
  DEFAULT_JOURNALING_POLICY,
  deriveHookNames,
  parseHookKey,
  GATEWAY_ADMISSION_FAILED,
  GATEWAY_CAPABILITIES_CHANGED,
  GatewayBridgeSlotOccupied,
  GatewayClosedError,
  GatewayLifecycleError,
  GatewayNotStartedError,
  resolveTruncateToolResults,
  toRegistration,
} from "@agentick/spec";
import { createWireExtensionRegistry } from "./wire-registry.js";
import { unconfiguredAuthorizer } from "./authorizers.js";
import { createCommandsListHandler, createDynamicCommandResolver } from "./dynamic-commands.js";
import {
  appWireExtension,
  gatewayWireExtension,
  sessionWireExtension,
  subscriptionsWireExtension,
} from "./wire/index.js";
import { mergeLayered, omitUndefined } from "@agentick/utils";
import {
  AppHarness,
  buildTelemetryExport,
  builtinWireExtensions,
  normalizeTelemetry,
  type AppHarnessOptions,
  type NormalizedTelemetry,
} from "@agentick/app";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

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
//   - `gateway:accept` (see `accept`) mints `onBeforeGatewayAccept` /
//     `onAfterGatewayAccept` — the per-connection admission seam (ADR 84 §4).
//     Fired ONCE per newly-accepted persistent connection by a
//     connection-oriented transport (WebSocket / Unix socket), after
//     ingress-authn and before the connection is wired to receive frames. The
//     before-hook sees the `ConnectionInfo` and throws to REJECT (the transport
//     drops the connection); the after-hook observes. HTTP is request-oriented
//     and does NOT fire it — its admission is the per-request `authorize` path.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "gateway:start": { input: undefined; output: void };
    "gateway:close": { input: undefined; output: void };
    "gateway:create-app": { input: CreateGatewayAppInput; output: AppHarnessProtocol };
    "authorizer:authorize": { input: AuthorizeInput; output: AuthorizeResult };
    "gateway:accept": { input: ConnectionInfo; output: void };
  }
}

// ============================================================================
// Options
// ============================================================================

/**
 * Concrete `CreateAppInput` typed against `@agentick/app`'s
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
  readonly authorizer?: import("@agentick/spec").Authorizer;
  /**
   * Truncate oversized tool results in the copy sent to CLIENTS over the
   * wire (ROADMAP A3) — STRICTLY OPT-IN. When enabled, bounds oversized
   * tool-result content on every client-facing frame (RPC results +
   * progress/subscription notifications) at the wire dispatch boundary. The
   * model and the durable store ALWAYS receive the full content — only the
   * client copy is truncated.
   *
   * OFF by default (omitted / `false`): the wire boundary skips the
   * projection entirely (zero overhead). Output shaping is app-UX POLICY —
   * payload size in a transcript is the app developer's call — so the
   * framework ships the capability off, unlike SECURITY defaults which
   * protect the operator and ship on. Enable (the `createApp({ telemetry })`
   * twin — `boolean | options` shape):
   *   - `true` — on at the 32 KiB
   *     {@link import("@agentick/spec").DEFAULT_MAX_TOOL_RESULT_BYTES}
   *     default;
   *   - `{ maxBytes }` — on, tuned ceiling;
   *   - `{ truncate }` — on, replacing the per-block bounder (its `ctx.bound`
   *     still delegates to the default).
   */
  readonly truncateToolResults?: import("@agentick/spec").TruncateToolResultsSetting;
  /** Stable gateway id; defaults to `gateway:${ulid()}`. */
  readonly gatewayId?: string;
  /**
   * Gateway-level tool declarations (layered config). Every app
   * hosted by this gateway sees these tools in every session, tagged
   * with `binding: { scope: "gateway" }`.
   *
   * The lowest non-`runtime` rung in the precedence ladder — every
   * app/session/execution/extension/compiler-scoped tool overrides
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
   * @see ToolBinding in `@agentick/spec` for the precedence ladder.
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
   * inProcess) ship from the `@agentick/transport-<edge>` packages; this
   * slot accepts any of them (or a test double). Omitted → the fan-out is
   * a no-op and `listen()` just flips ready.
   */
  readonly transports?: readonly ServerTransport[];

  /**
   * Telemetry switch (ADR 78, telemetry rung 1) — STRICTLY OPT-IN. Two roles at
   * the gateway:
   *
   *   1. **Gateway's own ops export.** The gateway builds an app-scoped
   *      {@link ManagedRuntime} from this setting (exactly as `AppHarness`
   *      does) and runs every gateway operation (`listen` / `close` /
   *      `authorize` / `accept` / `create-app` / wire dispatch) on it, so each
   *      op's `Effect.withSpan` span EXPORTS to the configured tracer.
   *   2. **Substrate inheritance.** Every app the gateway hosts that does NOT
   *      specify its own `telemetry` inherits this setting (default-chained
   *      through `createApp`), so a single gateway-level switch lights up
   *      telemetry across the whole deployment. An app-supplied `telemetry`
   *      always wins over the inherited default.
   *
   * Accepts the same three forms as `createApp({ telemetry })`: `true`
   * (enrichment defaults), an Effect `Layer` (BYO OTel backend), or a
   * `{ serviceName?, attributes?, layer? }` object. Omitted / `false` → OFF:
   * no runtime, no inheritance, zero overhead.
   *
   * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
   */
  readonly telemetry?: TelemetrySetting;
}

// ============================================================================
// GatewayHarness
// ============================================================================

const SURFACE = "gateway" as const;

export class GatewayHarness extends BaseHarness<typeof SURFACE> implements GatewayHarnessProtocol {
  private readonly _apps = new Map<string, AppHarnessProtocol>();
  /** ADR 51 §4 — read by the wire dispatch choke point (every method,
   *  both lanes) and by commands/list's visibility filter. */
  readonly authorizer!: import("@agentick/spec").Authorizer;
  /** ROADMAP A3 — client tool-output projection, read by the wire dispatch
   *  boundary (`dispatchRequest`). `undefined` = OFF (opt-in; the boundary
   *  then skips projection — zero overhead). */
  readonly clientProjection?: import("@agentick/spec").ToolOutputBounder;
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

  /**
   * Raw telemetry setting supplied at construction (ADR 78). Retained for
   * SUBSTRATE INHERITANCE — {@link createAppBody} default-chains it into every
   * hosted app that does not specify its own `telemetry`. `undefined` when the
   * gateway ships no telemetry.
   */
  private readonly telemetrySetting: TelemetrySetting | undefined;
  /**
   * Gateway-scoped telemetry runtime (ADR 78) — the tracer twin of
   * `AppHarness.telemetryRuntime`. Built ONCE in {@link initTelemetryExport}
   * from {@link telemetrySetting}; every gateway operation runs on it (via
   * {@link runGatewayOp}) so the op's `Effect.withSpan` span exports. Disposed
   * in {@link close} AFTER the close op ran on it. `undefined` when no span
   * export is wired. Set async (before `gatewayReady`), hence not `readonly`.
   *
   * The gateway also owns a `ctx.metrics` surface — the wire-extension handler
   * ctx (ADR 64/78): `runWireDispatch` attaches the meter behind `ctx.metrics`
   * from {@link telemetryProvider}. A `MetricReader` an app inherits binds to
   * exactly one `MeterProvider`, so this is safe against double-binding only
   * because `buildTelemetryExport` MEMOIZES one `MeterProvider` per reader-set
   * (multi-app safety) — the gateway and its hosted apps resolve the SAME meter
   * instance.
   */
  private telemetryRuntime: ManagedRuntime.ManagedRuntime<never, never> | undefined;
  /**
   * Releases the gateway's hold on the shared metrics `MeterProvider` (ADR 78),
   * built alongside {@link telemetryRuntime}. Refcounted in `buildTelemetryExport`
   * — the last holder out shuts the provider down. Called in {@link close}.
   */
  private telemetryReleaseMeter: (() => Promise<void>) | undefined;
  /**
   * Resolves when the async telemetry export build completes. Awaited by
   * {@link gatewayReady}, so no gateway op runs on a half-built runtime.
   */
  private readonly telemetryReady: Promise<void>;

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

    // ROADMAP A3 — resolve the opt-in `truncateToolResults` switch once into
    // the internal `clientProjection` bounder. OFF (undefined) unless the
    // adopter opts in; the wire dispatch boundary reads `this.clientProjection`
    // and skips projection when undefined.
    this.clientProjection = resolveTruncateToolResults(options.truncateToolResults);

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

    // Telemetry (ADR 78) — STRICTLY OPT-IN. Retain the raw setting for
    // substrate inheritance (createAppBody default-chains it), and build the
    // gateway's OWN export runtime ASYNC (env-driven OTLP autodiscovery lazily
    // imports the optional sink package). `gatewayReady` awaits `telemetryReady`,
    // so `telemetryRuntime` is always set before the first gateway op reads it.
    this.telemetrySetting = options.telemetry;
    // The gateway exports SPANS for its own ops (`runGatewayOp`) AND owns a
    // `ctx.metrics` surface — the wire-extension handler ctx (ADR 64/78). So it
    // builds BOTH halves of the export from the full setting (readers included),
    // NOT a tracer-only slice.
    //
    // CONSTRAINT that makes this safe: an OTel `MetricReader` binds to exactly
    // ONE `MeterProvider` (a second `new MeterProvider({ readers })` over the
    // same reader THROWS "MetricReader can not be bound to a MeterProvider
    // again"). The gateway and every hosted app that inherits this setting
    // (`createAppBody` default-chains `telemetrySetting`) share the SAME reader
    // instances — so N independent `MeterProvider`s would double-bind. The one
    // thing preventing that: `buildTelemetryExport` MEMOIZES a single
    // `MeterProvider` per reader-set and refcounts holders (last one out shuts it
    // down). Gateway + apps therefore resolve the SAME meter — pass the full
    // `normalized` setting through; do NOT zero the readers here.
    const normalized = normalizeTelemetry(options.telemetry);
    this.telemetryReady = this.initTelemetryExport(normalized);

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
    // so an adopter may still gate or override them. `@agentick/app` names them so
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
    return Promise.all([this.ready, this.gatewayExtensionsReady, this.telemetryReady]).then(
      () => {},
    );
  }

  /**
   * Build the telemetry EXPORT surface (tracer runtime + metrics meter) from
   * the normalized switch — the twin of `AppHarness.initTelemetryExport`. Async
   * because env-driven OTLP autodiscovery lazily imports the optional
   * `@agentick/telemetry-otlp` package. OFF (`!enabled`) → all three fields
   * stay `undefined` (zero overhead). Awaited by {@link gatewayReady}.
   */
  private async initTelemetryExport(n: NormalizedTelemetry): Promise<void> {
    const built = await buildTelemetryExport(n);
    this.telemetryRuntime = built.runtime;
    this.telemetryReleaseMeter = built.releaseMeter;
    // ADR 64/78 — hand a provider to the wire-dispatch facet builder even when
    // no meter is wired (enrichment-on-no-export still lights `ctx.trace` on the
    // captured op runtime). OFF → no provider (the facets take the shared
    // off-path singletons). The `meter` (when present) is the SHARED, memoized
    // instance hosted apps also resolve — no double-bind.
    this.telemetryProvider = n.enabled ? omitUndefined({ meter: built.meter }) : undefined;
  }

  /**
   * Run a gateway operation on the gateway's telemetry runtime (ADR 78). The
   * SECOND `runHarnessProtocol` arg routes the op's `Effect.withSpan` span to
   * the configured tracer; `undefined` (no telemetry) falls through to the
   * default runtime — behavior-preserving. Every gateway op call site uses this
   * (never bare `runHarnessProtocol`) so spans export uniformly.
   */
  private runGatewayOp<R>(eff: Effect.Effect<R, unknown, never>): Promise<R> {
    return runHarnessProtocol(eff, this.telemetryRuntime);
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
      // ADR 93 landmine 11 — the cascade is TOTAL at every host tier. A
      // gateway-installed harness spreads `inheritedFrom(installer)` and
      // inherits `gateway.use()` / `gateway.guard()` / `gateway.hook()`;
      // `interceptorParent: this` keeps it live for later registrations.
      interceptors: {
        inheritedInterceptors: this.resolvedInterceptors(),
        interceptorParent: this,
      },
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
  runWireDispatch<R>(
    method: WireMethod,
    params: unknown,
    ctx: WireExtensionContext,
    run: (params: unknown) => Promise<R>,
  ): Promise<R> {
    // Thread the per-request ingress identity (ADR 34/51) onto the wire op's
    // scope — the same carrier `origin` rides (see operation-runner's ctxScope
    // build). This is the ONE hop that lets a gateway `onBeforeWire<...>` hook
    // read `ctx.identity` (WHO is calling) and reshape params: the op scope →
    // ctxScope → the interceptor cascade's InterceptorCtx. Client-unsettable —
    // it comes from the identity the transport authenticated, never from params.
    // `omitUndefined` keeps the scope clean on the unauthenticated local pole
    // (no identity → the field is absent, non-wire ops are unaffected).
    const scope = omitUndefined({ gatewayId: this.scopeId, identity: ctx.identity });
    // `wire:` prefix (ADR 83 wire section): the wire op name must NOT
    // collide with the op it delegates to (`session/send` vs `session:send`
    // both Pascalize to `SessionSend`). Prefixed → `WireSessionSend`, so the
    // wire boundary hook is `onBeforeWireSessionSend`, distinct from the
    // session op's `onBeforeSessionSend` (which folds down live from the
    // gateway and fires once at the session).
    const opName = `wire:${method}`;
    const op: Operation<unknown, R, unknown> = {
      opId: `${opName}:${ulid()}`,
      surface: SURFACE,
      name: opName,
      scope,
      input: params,
    };
    const opEffect = this.runOperation(op, (input) =>
      Effect.gen(this, function* () {
        // ADR 64/78 — attach the Observability + Ops facets to the wire
        // handler ctx IN-FIBER, so the
        // captured op runtime (parent span + tracer) is the one `ctx.trace`
        // nests under and `ctx.metrics` reaches the gateway meter. Ambient
        // label `{ method }` (low-cardinality — the wire method, NOT a
        // per-request id). The facet getters are lazy: a handler that never
        // touches telemetry pays nothing.
        const runtime = yield* Effect.runtime<never>();
        this.defineOperationFacets(ctx, scope, runtime, undefined, { method });
        // `input` is the op's input AFTER the before-hooks in the interceptor
        // cascade ran — so a `onBeforeWire<...>` hook that RESHAPES the params
        // is honored: the reshaped value is what reaches the handler.
        return yield* Effect.tryPromise({
          try: () => run(input),
          catch: (cause) => cause,
        });
      }),
    );
    // ADR 42 define-time op config — compose the method's guard + middleware
    // onto THIS wire op via the existing tier-4 call-scoped seam, and annotate
    // its span with the static spanAttributes. Each self-scopes to the wire op's
    // command so they never leak to the nested domain ops the handler triggers.
    // No config → `withCallMiddleware([], …)` is a pass-through (zero overhead).
    const interceptors = this.buildWireOpInterceptors(opName, method, ctx);
    return this.runGatewayOp(withCallMiddleware(interceptors, opEffect));
  }

  /**
   * Build the tier-4 call-scoped interceptors for a wire op from its
   * define-time {@link WireOpConfig} (ADR 42 method dichotomy, normalized by
   * `defineWireExtension`). The guard desugars to a `guard`-kind interceptor
   * (raising an {@link import("@agentick/runtime").signalFromVerdict}
   * control-signal on veto/defer/replace); each middleware to a `transform`;
   * `spanAttributes` to an `observe` that annotates the op span. All three
   * self-scope to the wire op's command (`ctx.op` — the Pascal of the op name,
   * e.g. `WireSessionSend`) via {@link scopeToCommand}, so they act ONLY on the
   * wire op and never on the nested `session:send` / `tool:dispatch` ops the
   * handler triggers under the same call-scoped fiber. Empty list when the
   * method declared no op config.
   */
  private buildWireOpInterceptors(
    opName: string,
    method: WireMethod,
    ctx: WireExtensionContext,
  ): Middleware<unknown, unknown, unknown>[] {
    // Indexing `ops` by the `WireMethod` union yields a union of `WireOpConfig<K>`;
    // collapse to the base `WireOpConfig` (the fields are read uniformly below).
    const cfg = this._wireExtensions.resolve(method)?.extension.ops?.[method] as
      | WireOpConfig
      | undefined;
    if (cfg === undefined) return [];
    // The wire op's command tag — the exact value `runOperation` stamps on
    // `ctx.op` (`parseHookKey(deriveHookNames(name)[0]).command`). Guards /
    // middleware compare against it to fire only on this op.
    const command = parseHookKey(deriveHookNames(opName)[0])?.command as string;
    const out: Middleware<unknown, unknown, unknown>[] = [];

    if (cfg.guard !== undefined) {
      const guard = cfg.guard as WireGuard<WireMethod>;
      const guardMw: AsyncMiddleware = async (input, next) => {
        const verdict = await guard(input as WireParams<WireMethod>, ctx);
        // proceed / void → call next; veto/defer/replace → raise the
        // control-signal the operation runner maps to a terminal.
        if (verdict && verdict.kind !== "proceed") throw signalFromVerdict(verdict);
        return next(input);
      };
      out.push(
        tagInterceptor("guard", liftMiddleware(scopeToCommand(command, guardMw))) as Middleware<
          unknown,
          unknown,
          unknown
        >,
      );
    }

    for (const mw of cfg.middleware ?? []) {
      const userMw = mw as WireMiddleware<WireMethod>;
      const asyncMw: AsyncMiddleware = (input, next) =>
        userMw(
          input as WireParams<WireMethod>,
          next as (p: WireParams<WireMethod>) => Promise<WireResult<WireMethod>>,
          ctx,
        );
      out.push(
        tagInterceptor("transform", liftMiddleware(scopeToCommand(command, asyncMw))) as Middleware<
          unknown,
          unknown,
          unknown
        >,
      );
    }

    if (cfg.spanAttributes !== undefined) {
      const attrs = cfg.spanAttributes;
      // Effect-native `observe` — annotate the ambient (wire op) span in-fiber.
      // Self-scopes by `ctx.op` so it never annotates nested op spans.
      const spanMw: Middleware<unknown, unknown, unknown> = (input, next) =>
        Effect.gen(function* () {
          const rc = yield* getContext;
          if (rc.op === command) yield* annotateOperationSpan(attrs);
          return yield* next(input);
        });
      out.push(tagInterceptor("observe", spanMw));
    }

    return out;
  }

  /**
   * Emit the control-plane "wire-extension set changed" signal
   * (ADR 47). Appends a {@link GATEWAY_CAPABILITIES_CHANGED} event to
   * the gateway bus on the gateway scope. Clients subscribed to the
   * gateway control-plane scope (every `@agentick/client-core` on
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

  /**
   * Publish an ingress admission failure (ADR 92 §Family 1.3) — a crossing a
   * transport edge REFUSED before any work unit existed. Called by the edge's
   * rejection path (`authenticateIngress`'s reporter), so the audit trail sees
   * probing that never got past 401 instead of nothing at all.
   *
   * An EVENT, not an operation: nothing ran, so there is no work to journal —
   * only the attempt to record. Twin of `mcpServer:admission:failed`. The
   * payload carries the connection shape and a failure class; the
   * credential never enters it (see {@link IngressAdmissionFailure}).
   */
  emitAdmissionFailure(failure: IngressAdmissionFailure): void {
    void Effect.runPromise(
      this.bus.append({
        id: `evt_${ulid()}`,
        surface: SURFACE,
        name: GATEWAY_ADMISSION_FAILED,
        phase: "terminal",
        outcome: "failed",
        timestamp: Date.now(),
        scope: { gatewayId: this.scopeId, origin: "wire" },
        payload: { ...failure },
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
    return this.runGatewayOp(
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
      // Telemetry inheritance (ADR 78). The app-supplied `telemetry` (spread
      // above via `...input.options`) always wins; only when the app omits it
      // AND the gateway ships one do we default-chain the gateway's setting
      // down, so a single gateway-level switch lights up telemetry across every
      // hosted app while a per-app override stays authoritative.
      ...(input.options.telemetry === undefined && this.telemetrySetting !== undefined
        ? { telemetry: this.telemetrySetting }
        : {}),
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
    return this.runGatewayOp(
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
  async close(opts: { drain?: boolean } = {}): Promise<void> {
    if (this.gatewayClosed) {
      return;
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
    await this.runGatewayOp(
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
    // Dispose the telemetry runtime AFTER the close op ran on it, so its own
    // span is captured and the exporter flushes pending spans (ADR 78) — the
    // exact ordering `AppHarness.closeApp` uses. Then release the gateway's hold
    // on the shared metrics MeterProvider (refcounted — the last holder out
    // shuts it down); the wire-dispatch `ctx.metrics` surface consumed it.
    if (this.telemetryRuntime !== undefined) await this.telemetryRuntime.dispose();
    if (this.telemetryReleaseMeter !== undefined) await this.telemetryReleaseMeter();
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
    return this.runGatewayOp(
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

  /**
   * Per-connection admission (ADR 84 §4). Wraps the hookable `gateway:accept`
   * op via `runOperation` (mirroring {@link authorize} / {@link close}): the
   * before-hook (`onBeforeGatewayAccept`) sees the {@link ConnectionInfo} and
   * gates / rate-limits / observes — throwing REJECTS the connection, which the
   * calling transport drops; the after-hook (`onAfterGatewayAccept`) observes.
   * The op body is a pure no-op — admission IS the before-hook seam; there is
   * nothing to do on the happy path but let the connection through.
   *
   * Only a bound transport calls this, and a transport only accepts connections
   * after {@link listen} has bound it — so a live connection already implies a
   * started gateway. No redundant started-gate is added here (unlike
   * {@link createApp}, which an adopter can call directly on a not-started
   * gateway).
   */
  accept(info: ConnectionInfo): Promise<void> {
    const op: Operation<ConnectionInfo, void, never> = {
      opId: `gateway:accept:${ulid()}`,
      surface: SURFACE,
      name: "gateway:command:accept",
      scope: { gatewayId: this.scopeId },
      input: info,
    };
    return this.runGatewayOp(
      this.runOperation(op, () =>
        Effect.tryPromise({
          // No body — admission is the `onBeforeGatewayAccept` seam. A throwing
          // before-hook short-circuits before this ever runs (the rejection
          // propagates out to the transport, which drops the connection).
          try: () => Promise.resolve(),
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
 * (the twin of `@agentick/app`'s `mapAppError`). A typed `AgentickError`
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
