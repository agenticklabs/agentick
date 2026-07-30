/**
 * Extension protocol — uniform mechanism for installing harnesses onto
 * host harnesses (AppHarness, SessionHarness, ...).
 *
 * Per ADR 26 ("Harness as the single shape"): there is one concept —
 * Harness — and one mechanism for installing one harness inside another:
 * the {@link Extension} discriminated union, dispatched by `target`.
 *
 * Each host harness type ships its own {@link AppInstaller}-like installer
 * interface documenting the slot bag + lifecycle hooks it offers to
 * extensions. New host harness types add new variants without touching
 * the base — the union is open via `(string & {})`.
 *
 * Adopters compose extensions in the host harness's options:
 *
 *   createApp(<Agent />, {
 *     extensions: [
 *       withKnobs(),                // SessionExtension
 *       ...withSandbox(),           // returns readonly [AppExtension, SessionExtension]
 *       withMCP({ servers: [...] }),// SessionExtension
 *     ],
 *   });
 *
 * The framework filters by `target` and dispatches each extension to the
 * right installer at the right lifecycle phase.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { EventQuery, ProtocolEvent } from "../data/events.js";
import type { ToolHandler } from "../data/tool-handler.js";
import type { Validator } from "../data/validator.js";
import type { EventBus } from "./bus.js";
import type { MessageInbox, Unsubscribe } from "./inbox.js";
import type { OperationJournal } from "./journal.js";
import type { Middleware } from "./middleware.js";

// ============================================================================
// HarnessKind — open string union of host harness targets
// ============================================================================

/**
 * Discriminator for {@link Extension} variants. The framework's
 * built-in hosts ship variants for `"app"` and `"session"`; new harness
 * packages add their own (e.g., a compiler-side extension surface
 * would add `"compiler"`).
 */
export type HarnessKind = "gateway" | "app" | "session" | (string & {});

// ============================================================================
// Extension — discriminated union by target
// ============================================================================

export interface ExtensionBase {
  /**
   * Identifier for diagnostics + slot routing. Adopters who install
   * two extensions claiming the same `name` get last-writer-wins on
   * the slot (the framework default for required surfaces installs
   * first, so adopter overrides take precedence).
   */
  readonly name: string;
  /** Discriminator. Routes the extension to its host's installer. */
  readonly target: HarnessKind;
}

/**
 * Extension that installs at AppHarness construction. Receives an
 * {@link AppInstaller}. Used by extensions that hold app-scoped state
 * shared across every session (provider config, connection pools,
 * registries).
 */
export interface AppExtension extends ExtensionBase {
  readonly target: "app";
  install(installer: AppInstaller): void | Promise<void>;
}

/**
 * Extension that installs at SessionHarness construction. Receives a
 * {@link SessionInstaller}. The same extension factory may produce
 * BOTH an {@link AppExtension} and a {@link SessionExtension} — see
 * `withSandbox()` for the multi-target tuple pattern.
 */
export interface SessionExtension extends ExtensionBase {
  readonly target: "session";
  install(installer: SessionInstaller): void | Promise<void>;
}

/**
 * Extension that installs at GatewayHarness construction (ADR 50).
 * Receives a {@link GatewayInstaller}. Fires during construction,
 * before `gateway.ready`, before the wire-extension registry seals.
 * Used by extensions that equip the gateway itself — one shared
 * harness serving every app (credentials at gateway scope #283),
 * wire-method packages (MCP control plane #298), connectors, logging.
 *
 * Identical discipline to {@link AppExtension} / {@link SessionExtension}:
 * timing + host, not shape. What an extension *installs* (a harness, a
 * namespace, a bus subscriber, nothing) is ADR 32's business.
 */
export interface GatewayExtension extends ExtensionBase {
  readonly target: "gateway";
  install(installer: GatewayInstaller): void | Promise<void>;
}

/**
 * Open union. Existing variants cover the built-in hosts; new harness
 * packages ship their own variants. The `(string & {})` escape on
 * {@link HarnessKind} lets adopters declare those without touching
 * `@agentick/spec`.
 *
 * Note: `Extension` covers the app/session hosts (what `createApp`
 * accepts directly). The gateway host + composite bundles are the
 * wider {@link AnyExtension} union, which `createGateway` accepts.
 */
export type Extension = AppExtension | SessionExtension;

/**
 * Composite produced by a `withX()` factory that spans scopes (#297).
 * `createGateway({ extensions })` distributes each part to its correct
 * scope: `gateway` installs during gateway construction, `wire`
 * registers into the ADR 46 registry now, `app`/`session` become
 * cascaded defaults for every `gateway.createApp` / `createSession`
 * beneath. One adoption site, correct scope per part.
 */
export interface ExtensionBundle {
  readonly name: string;
  readonly gateway?: GatewayExtension;
  readonly app?: AppExtension;
  readonly session?: SessionExtension;
  readonly wire?: readonly import("../wire/extension.js").WireExtension[];
}

/**
 * What `createGateway({ extensions })` accepts: bare extensions of any
 * target, or a composite {@link ExtensionBundle}. A bare
 * {@link GatewayExtension} is treated as `{ gateway }`.
 */
export type AnyExtension = GatewayExtension | AppExtension | SessionExtension | ExtensionBundle;

// ============================================================================
// Installers — per-host integration contract
// ============================================================================

/**
 * Methods every installer offers, regardless of host harness type.
 * Extension authors writing host-agnostic helpers can target this base.
 */
/**
 * The host's interceptor-inheritance handle, as carried on a
 * {@link BaseInstaller} (ADR 93 landmine 11). Structurally the
 * `inheritedInterceptors` / `interceptorParent` pair a harness constructor
 * takes; spread it into your harness options via `inheritedFrom(installer)`.
 */
export interface InstallerInterceptors {
  /**
   * The host's RESOLVED interceptor snapshot at install time — its own
   * `.use` / `.guard` / `.hook` registrations plus everything it inherited,
   * ordered root-outermost. Seeds the child's inherited layer.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * The host harness as the LIVE interceptor parent (ADR 83 §4), so a
   * registration made AFTER the child exists still reaches it. Typed `unknown`
   * because the nominal `BaseHarness` lives in `@agentick/runtime`; use
   * `inheritedFrom(installer)` from that package to recover the precise type.
   */
  readonly interceptorParent?: unknown;
}

export interface BaseInstaller {
  /** Unique identifier of the host harness this installer belongs to. */
  readonly hostId: string;

  /**
   * Shared substrate primitives the host owns. Extensions construct
   * sub-harnesses using these so the sub-harnesses' events flow into
   * the host's journal + bus and surface via `host.events(...)`.
   */
  readonly substrate: AppSubstrate;

  /**
   * The host's INTERCEPTOR-INHERITANCE handle (ADR 93 landmine 11) — the
   * construction snapshot of the cascade plus the live parent, in exactly the
   * shape a harness constructor takes.
   *
   * **Why this exists.** An extension-installed harness that does not thread
   * this is INVISIBLE to `app.guard()` / `app.hook()` / `createApp({ hooks,
   * guards })` — its ops run outside the cascade. That was silently true for
   * every extension-installed namespace (the ADR-92 escape at the subscriptions
   * extension), and it becomes a correctness bug the moment definitions
   * advertise `hooks:` / `guards:` bags: adopters will assume the app bag wraps
   * everything. Spread it into your harness options and the cascade is total:
   *
   * ```ts
   * new MyHarness(id, journal, bus, inbox, { ...config, ...inheritedFrom(installer) });
   * ```
   *
   * `inheritedFrom` (`@agentick/runtime`) is the typed accessor — it recovers
   * the nominal parent type that spec cannot name (the nominal `BaseHarness`
   * lives in `@agentick/runtime`; spec has no upward dep, hence the `unknown`).
   */
  readonly interceptors: InstallerInterceptors;

  /**
   * Register a sub-harness under the given slot name. Slot lookup uses
   * last-writer-wins — framework defaults install first; adopter
   * overrides replace them. Returns an unsubscribe that removes the
   * registration.
   *
   * Adopters augment the host's `*Extensions` slot interface (via
   * `declare module "@agentick/spec"`) to type the slot at consumption.
   */
  registerNamespace(name: string, harness: unknown): Unsubscribe;

  /**
   * Look up another sub-harness by slot name. Used by extensions that
   * compose over peers — e.g., GatesHarness reads KnobsHarness via
   * `installer.getNamespace<KnobsHarness>("knobs")`.
   *
   * Returns `undefined` when no harness is registered under that name.
   * Lookup is dynamic — late-installed extensions become visible as
   * soon as their `install` returns.
   *
   * ## Ordering: HOST bridges are not visible at install time (#257)
   *
   * A session is constructed AFTER its extensions install, so the bridges the
   * session owns (`timeline`, `knobs`, `state`, …) do not yet exist while
   * `install` runs — `getNamespace("timeline")` inside `install` returns
   * `undefined` no matter how the extensions are ordered. The host publishes
   * them into this same map once the session is constructed.
   *
   * An extension that needs a host bridge must therefore LATE-BIND: hold
   * `() => installer.getNamespace<T>(name)` and call it when it uses the value,
   * not when it installs. Resolving eagerly caches the miss for the lifetime of
   * the session — which is exactly how `@agentick/prompts` came to render every
   * invoked prompt into a timeline it never had.
   *
   * Peer EXTENSION namespaces (`prompts`, `credentials`, …) have no such
   * constraint: they are registered during the same install pass and an eager
   * read sees any extension installed before this one.
   */
  getNamespace<T>(name: string): T | undefined;

  /**
   * Register a callback fired when the host harness closes. Extensions
   * use this to clean up resources, unsubscribe from external services,
   * etc. Handlers run in reverse registration order; one handler's
   * failure does not block others.
   */
  onClose(handler: () => void | Promise<void>): void;
}

/**
 * AppHarness installer. Exposes additional registration surfaces beyond
 * the base — compiler contributors (for React-bound extensions), tool
 * handler pre-registration, bus subscriptions for telemetry/observability.
 */
export interface AppInstaller extends BaseInstaller {
  readonly kind: "app";

  /**
   * Add a `Contributor` to the compiler's registry. Compiler-specific:
   * the type parameter is whatever shape the active compiler uses for
   * host instances (`HostInstance` in `@agentick/compiler`).
   *
   * Non-compiler extensions skip this method.
   */
  registerContributor<TContributor = unknown>(contributor: TContributor): Unsubscribe;

  /**
   * Pre-register a tool handler with the shared HandlerResolver. Useful
   * for extensions that ship built-in tools — registration runs before
   * any JSX tool components mount.
   */
  registerToolHandler(handlerRef: string, handler: ToolHandler, validator?: Validator): Unsubscribe;

  /**
   * Pre-register a tool declaration so every session the app
   * constructs auto-installs it into its `ToolExecutor.initialTools`.
   *
   * Complement to {@link registerToolHandler} — that registers the
   * runtime handler on the shared HandlerResolver; this records the
   * declaration + handlerRef pair so each new session knows the tool
   * exists. Together they let an extension (e.g., `withMCP()`) expose
   * tools discovered at app-install time to every session the app
   * creates afterward.
   *
   * Tools registered here are appended to the per-call
   * `toolDefaults.initialTools` when `app.createSession` constructs
   * the per-session `ToolExecutor`. Adopter-supplied tools win on
   * name collision (extension tools install first).
   */
  registerExtensionTool(registration: import("./tool-executor.js").ToolRegistration): Unsubscribe;

  /**
   * Subscribe to the app's bus. Used by telemetry / observability /
   * external-driver extensions (e.g., a scheduler listening for
   * subscription-intent events).
   */
  subscribeBus(
    filter: EventQuery,
    listener: (event: ProtocolEvent) => void | Promise<void>,
  ): Unsubscribe;

  /**
   * Reference to the AppHarness for late-binding interactions. Opaque
   * to the spec; the runtime types it concretely.
   */
  readonly app: AppInstallerHost;
}

/**
 * SessionHarness installer. The session's host (its AppHarness)
 * forwards SessionExtensions to every session it constructs. Each
 * session install runs against a fresh SessionInstaller bound to that
 * session's substrate.
 *
 * Exposes a tool-registration surface mirroring {@link AppInstaller}'s
 * but scoped to THIS session — session-level tools land in the
 * session's ToolExecutor with `binding.scope: "extension"` +
 * `level: "session"`, placing them above app/extension/gateway tools
 * in the precedence ladder (`compileForTick`).
 */
export interface SessionInstaller extends BaseInstaller {
  readonly kind: "session";

  /**
   * Reference back to the owning AppHarness. Useful for session
   * extensions that need to reach app-level shared state — e.g., a
   * sandbox session extension reads the app-level sandbox provider
   * registered by its sibling AppExtension via the shared factory
   * closure.
   */
  readonly app: AppInstallerHost;

  /**
   * The session's id. Same value as `hostId`, surfaced under a more
   * semantic name for session-extension code that stamps
   * scope-aware envelopes (`{ sessionId }`) or constructs sub-harness
   * addresses derived from the sessionId.
   */
  readonly sessionId: string;

  /**
   * The session's owning principal (ADR 48) at install time — the same value
   * carried on the session harness + its durable `SessionRecord`. Exposed here
   * so a session extension can construct per-session, tier-scoped backing
   * stores keyed by identity at install (e.g.
   * `new SkillStore({ dataSource, context: fromPrincipal(installer) })`).
   * `undefined` for a principal-less session.
   */
  readonly principal?: string;

  /**
   * The session's adopter metadata bag at install time — the same
   * `CreateSessionInput.metadata` carried on the session harness + record's
   * open over-fetch bag. Read by extensions that key backing resources off
   * adopter routing data (tenant id, region, …) supplied at session creation.
   * Frozen; framework defines no keys.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /**
   * The session's elicitation harness — constructed by the host
   * BEFORE session-extension installs run, so extensions that need
   * cluster-friendly inbox routing to the session's user (MCP,
   * sampling, roots bridges, OAuth-via-elicit) read its `.address`
   * directly here. Sessions aren't yet registered in
   * `app.getSession(...)` at install time; this slot is the
   * documented seam.
   *
   * Single-construction-site invariant (#159): this is THE SAME
   * instance used by the session's `ToolExecutor` (`ctx.elicitation`)
   * and `bridges.elicitation`. Extensions must NOT construct their
   * own `ElicitationHarness` against the substrate — addresses would
   * collide and bridges + tool-executor would resolve to different
   * registries.
   */
  readonly elicitation: import("./elicitation-harness.js").ElicitationHarnessProtocol;

  /**
   * The session's tasks harness — constructed by the host BEFORE
   * session-extension installs run, symmetrically with
   * {@link SessionInstaller.elicitation}. Extensions wiring
   * model-facing surfaces over the task substrate (`withTasks`,
   * MCP task-mode tools, etc.) read this instance directly.
   *
   * Single-construction-site invariant (#159): this is THE SAME
   * instance used by the session's `ToolExecutor` (`ctx.tasks`),
   * `bridges.tasks`, and `session.tasks`. Extensions must NOT
   * construct their own `TasksHarness` against the substrate —
   * addresses would collide (both registering `tasks:${sessionId}:tasks`)
   * and bridges + tool-executor would resolve to different
   * registries.
   */
  readonly tasks: import("./tasks-harness.js").TasksHarnessProtocol;

  /**
   * The session's resources harness (ADR 62) — constructed by the host
   * BEFORE session-extension installs run, symmetrically with
   * {@link SessionInstaller.tasks} and {@link SessionInstaller.elicitation}.
   * Extensions that surface readable content over the registry read this
   * instance directly: `withResources` registers model-facing
   * `resource_*` tools whose handlers reach it via `ctx.resource`;
   * `withMCP` proxy-registers each remote server's resources into it
   * (keyed by the adopter alias) at install time.
   *
   * Single-construction-site invariant (#159): this is THE SAME instance
   * used by the session's `ToolExecutor` (`ctx.resource`) and
   * `bridges.resources`. Extensions must NOT construct their own
   * `ResourcesHarness` against the substrate — addresses would collide
   * (both registering `resources:${sessionId}:resources`) and bridges +
   * tool-executor would resolve to different registries.
   */
  readonly resources: import("./resources-harness.js").Resources;

  /**
   * Pre-register a tool handler resolvable from THIS session's
   * dispatch. Routed into the session's tool-executor handler
   * registry. Mirrors {@link AppInstaller.registerToolHandler} but
   * scoped to the session.
   */
  registerToolHandler(handlerRef: string, handler: ToolHandler, validator?: Validator): Unsubscribe;

  /**
   * Pre-register a session-level tool declaration. Auto-installed into
   * the session's `ToolExecutor.initialTools` BEFORE the tool executor
   * is constructed. Binding shape: `{ scope: "extension",
   * extensionName, level: "session" }`. Per the layered-tools
   * precedence ladder, session-extension tools rank above
   * app-extension tools and below caller-supplied session tools.
   */
  registerExtensionTool(registration: import("./tool-executor.js").ToolRegistration): Unsubscribe;

  /**
   * Subscribe to the session's bus. Wraps the substrate's bus
   * subscription with the session's scope filter applied by default
   * (`{ sessionId }`). Extensions building telemetry / observability
   * over the session's event stream consume this surface.
   */
  subscribeBus(
    filter: EventQuery,
    listener: (event: ProtocolEvent) => void | Promise<void>,
  ): Unsubscribe;
}

/**
 * GatewayHarness installer (ADR 50). Mirrors {@link AppInstaller}'s
 * base surface plus gateway-only capabilities: the programmatic path
 * into the ADR 46 wire-extension registry, and typed namespace
 * registration into {@link GatewayBridges}.
 *
 * Runs during gateway construction, before `ready`, before the
 * wire-extension registry seals.
 *
 * (The auth seam — `interceptIngress`, token → principal at transport
 * ingress — is deferred to #302/ADR 34, which owns its context shape
 * and transport wiring. Recorded in ADR 50's 2026-07-01 amendment §1;
 * added there as a non-breaking `BaseInstaller` extension.)
 */
export interface GatewayInstaller extends BaseInstaller {
  readonly kind: "gateway";

  /**
   * Register a namespace into {@link GatewayBridges}, reachable via
   * `gateway.bridges.<name>`. **Occupied slot ⇒ throw** — the runtime
   * mirror of the type-level augmentation seam; prices version-skew
   * risk loudly rather than silently shadowing.
   *
   * The gateway slot is a **hard singleton** by decision (ADR 50
   * amendment §2): it has no outer scope, so a duplicate is two
   * extensions fighting for one global slot — a bug. The app-side
   * `extensionBridges` map is intentionally **last-writer-wins**: it
   * sits under the outer→inner extension cascade, where a duplicate slot
   * is an *override* (the more-specific scope wins), not a collision.
   */
  registerNamespace<K extends keyof GatewayBridges & string>(
    name: K,
    value: GatewayBridges[K],
  ): Unsubscribe;

  /**
   * Programmatic install into the ADR 46 wire-extension registry —
   * the third route beside `createGateway({ wireExtensions })` and
   * framework self-install. Valid only before the registry seals;
   * throws after `ready` (no dynamic post-ready install in v2.0).
   */
  registerWireExtension(extension: import("../wire/extension.js").WireExtension): void;

  /**
   * Subscribe to the gateway's bus — telemetry / observability /
   * external-driver extensions.
   */
  subscribeBus(
    filter: EventQuery,
    listener: (event: ProtocolEvent) => void | Promise<void>,
  ): Unsubscribe;

  /** Late-binding handle to the GatewayHarness. */
  readonly gateway: GatewayInstallerHost;
}

/**
 * Late-binding handle to the GatewayHarness an installer operates on.
 * Concrete type lives in `@agentick/gateway`; spec keeps it opaque.
 */
export interface GatewayInstallerHost {
  readonly gatewayId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Live apps hosted by this gateway. */
  readonly apps: () => readonly import("./app-harness.js").AppHarnessProtocol[];
}

/**
 * The shared substrate primitives the host harness owns. Forwarded to
 * extensions so they can wire sub-harnesses into the same journal /
 * bus / inbox the host uses — sub-harness events appear on
 * `host.events(...)` and the audit trail is unified.
 */
export interface AppSubstrate {
  readonly journal: OperationJournal;
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
}

/**
 * Late-binding handle to the host harness the installer is operating on.
 * Concrete type lives in the host's runtime package; spec keeps it
 * opaque.
 */
export interface AppInstallerHost {
  readonly appId: string;
  /**
   * Free-form metadata bag shared between extensions and the host —
   * useful for cross-extension state ("the scheduler extension says
   * cron jobs are firing in this app").
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Look up a live session by id. Returns `undefined` when no session
   * is currently registered under that id (including closed-and-removed
   * sessions). Mirrors {@link AppHarnessProtocol.getSession}.
   *
   * Optional because the concrete host may be a non-`AppHarness`
   * installer (mocks, future hosts that don't keep a session registry).
   * Extensions reading session-scoped bridges at runtime (e.g. MCP's
   * `withMCP` routing inbound `elicitation/create` to the in-flight
   * session's `bridges.elicitation`) should call this through the
   * optional chain and degrade gracefully when absent.
   */
  readonly getSession?: (
    sessionId: string,
  ) => import("./session-harness.js").SessionHarnessProtocol<unknown> | undefined;
}

// ============================================================================
// Module augmentation slots
// ============================================================================

/**
 * Typed bag of extension-installed harnesses reachable via
 * `app.extensions.<name>`. Extension packages augment this interface
 * via TypeScript module augmentation:
 *
 *   declare module "@agentick/spec" {
 *     interface AppExtensions {
 *       readonly sandbox?: SandboxHarness;
 *     }
 *   }
 *
 * Slots are optional — adopters who don't install the extension see
 * `undefined` at the type level too.
 */
export interface AppExtensions {}

/**
 * Sibling of {@link AppExtensions} for session-scoped extensions.
 * Reachable via `session.extensions.<name>`. Augmented the same way.
 */
export interface SessionExtensions {}

/**
 * Gateway-scope twin of {@link AppExtensions} — the typed bag of
 * gateway-extension-installed harnesses reachable via
 * `gateway.bridges.<name>` (ADR 50). Empty seed; the gateway-scope
 * mirror of `HookBridges` (ADR 27). Augmented the same way:
 *
 *   declare module "@agentick/spec" {
 *     interface GatewayBridges {
 *       readonly credentials: CredentialsHarnessProtocol;
 *     }
 *   }
 *
 * Unlike the app-side last-writer-wins `extensionBridges`, a
 * `GatewayBridges` slot is a hard singleton: `registerNamespace`
 * throws on an occupied slot.
 */
export interface GatewayBridges {}
