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

// ============================================================================
// HarnessKind — open string union of host harness targets
// ============================================================================

/**
 * Discriminator for {@link Extension} variants. The framework's
 * built-in hosts ship variants for `"app"` and `"session"`; new harness
 * packages add their own (e.g., a reconciler-side extension surface
 * would add `"reconciler"`).
 */
export type HarnessKind = "app" | "session" | (string & {});

// ============================================================================
// Extension — discriminated union by target
// ============================================================================

interface ExtensionBase {
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
 * Open union. Existing variants cover the built-in hosts; new harness
 * packages ship their own variants. The `(string & {})` escape on
 * {@link HarnessKind} lets adopters declare those without touching
 * `@agentick/spec-next`.
 */
export type Extension = AppExtension | SessionExtension;

// ============================================================================
// Installers — per-host integration contract
// ============================================================================

/**
 * Methods every installer offers, regardless of host harness type.
 * Extension authors writing host-agnostic helpers can target this base.
 */
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
   * Register a sub-harness under the given slot name. Slot lookup uses
   * last-writer-wins — framework defaults install first; adopter
   * overrides replace them. Returns an unsubscribe that removes the
   * registration.
   *
   * Adopters augment the host's `*Extensions` slot interface (via
   * `declare module "@agentick/spec-next"`) to type the slot at consumption.
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
 * the base — reconciler contributors (for React-bound extensions), tool
 * handler pre-registration, bus subscriptions for telemetry/observability.
 */
export interface AppInstaller extends BaseInstaller {
  readonly kind: "app";

  /**
   * Add a `Contributor` to the reconciler's registry. Reconciler-specific:
   * the type parameter is whatever shape the active reconciler uses for
   * host instances (`HostInstance` in `@agentick/reconciler-next`).
   *
   * Non-reconciler extensions skip this method.
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
   * The session's elicitation harness — constructed by the host
   * BEFORE session-extension installs run, so extensions that need
   * cluster-friendly inbox routing to the session's user (MCP,
   * sampling, roots bridges, OAuth-via-elicit) read its `.address`
   * directly here. Sessions aren't yet registered in
   * `app.getSession(...)` at install time; this slot is the
   * documented seam.
   */
  readonly elicitation: import("./elicitation-harness.js").ElicitationHarnessProtocol;

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
 *   declare module "@agentick/spec-next" {
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
