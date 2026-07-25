/**
 * AppHarnessProtocol — the outermost runtime boundary.
 *
 * The app harness owns the **agent definition** (the JSX root element,
 * shared defaults), the **session registry**, and the **shared substrate
 * + shared sub-harnesses** (compiler, loop executor, language-model
 * executor). Each session it creates is a `SessionHarnessProtocol`
 * instance bound to the same substrate, with its own scopeId.
 *
 * **MVP shape — 4f.** The blueprint specifies a richer protocol
 * (`use()` integrations, `events()` cross-session bus subscription,
 * persistence Layer, telemetry Layer, multi-tenant filtering, cluster
 * mode). Those land in follow-ups without breaking the 4f contract.
 *
 * Methods follow the harness convention: Promise-typed surface at the
 * boundary, Effect-driven internals via `runHarnessProtocol`.
 *
 * `[V1-REPLACED]` — v1's `Agentick` instance + `App` class
 * (`packages/core/src/app/app.ts`, `packages/core/src/agentick-instance.ts`).
 *
 * @see docs/proposals/v2/blueprint/09-app-harness.md
 */

import type { Layer } from "effect";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import type { EventQuery, ProtocolEvent } from "../data/events.js";
import type { SessionStatus } from "./hook-bridges.js";
import type { SessionRecord, SessionStoreQuery } from "./session-store.js";
import type { ExecutorFactory, ExecutorProtocol, LanguageModelExecutor } from "./executor.js";
import type { EventBus, EventBusFactory, SubscribeOptions } from "./bus.js";
import type { MessageInbox, MessageInboxFactory } from "./inbox.js";
import type { OperationJournal, OperationJournalFactory } from "./journal.js";
import type {
  SendInput,
  SendResult,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  SessionSubstrateParent,
} from "./session-harness.js";

// ============================================================================
// Command inputs / outputs
// ============================================================================

export interface CreateSessionInput<P = unknown> {
  /**
   * Stable session id. Generated if omitted. Supplying an id that is
   * already live returns the existing session (idempotent
   * open-or-rehydrate, ADR 49) — createSession is create AND resume.
   */
  readonly sessionId?: string;
  /** Scope ceiling for the session (#199) — construction-bound. */
  readonly requiredScopes?: readonly string[];
  /**
   * Adopter-defined metadata bag carried on the session and surfaced
   * to session-level substrate factories via `parent.metadata`.
   * Framework defines no keys.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * App-owned descriptive slots seeded onto the session's durable
   * `SessionRecord` (E11). The framework STORES these and is blind to their
   * semantics (auto-summary, user-edit). The app may also set them later via
   * `app.setSessionMeta(sessionId, ...)`. `agentId` is the stable agent id /
   * name for the record's `agentId` slot (1 agent : 1 session).
   */
  readonly title?: string;
  readonly description?: string;
  readonly agentId?: string;
  /** Initial component props injected into the agent root element. */
  readonly initialProps?: P;
  /** Initial knob values copied into the session's knob bridge. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  /** Override the app-level default `maxTicks` for this session. */
  readonly maxTicks?: number;
  /**
   * Session-level streaming default. Overridden per-call by
   * `SendInput.stream`. Falls through to the app default + executor
   * capability default when unset.
   */
  readonly streaming?: boolean;
  /**
   * Session-level model-narration switch. `false` disables injection of
   * the reserved `_summary` narration field into this session's
   * model-facing tool schemas — the token-cost off-switch. Falls through
   * to the app default (`createApp({ narrate })`), then to `true`.
   */
  readonly narrate?: boolean;
  /**
   * Per-session substrate overrides — instance or factory. When
   * omitted, the session inherits the app's substrate directly.
   *
   * Factory form is the multi-tenant lever: pass
   * `bus: LocalEventBus.factory()` to wrap the app's bus per session
   * (fan-in writes / isolated reads). Adopter routing data flows
   * through `metadata` and is readable on the factory's `parent`.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly bus?: EventBus | EventBusFactory<SessionSubstrateParent>;
  readonly inbox?: MessageInbox | MessageInboxFactory<SessionSubstrateParent>;
  readonly journal?: OperationJournal | OperationJournalFactory<SessionSubstrateParent>;
  /**
   * Override the app's rootElement for this session. Lets adopters
   * construct sessions with a different agent JSX without instantiating
   * a separate app.
   */
  readonly rootElement?: unknown;
  /** Per-session abort signal. Closes the session if it fires. */
  readonly signal?: AbortSignal;
  /**
   * Session-scoped tool declarations. Bound at session-create time
   * with `binding: { scope: "session", sessionId }` and entered into
   * the tool executor's registry. Participates in the per-tick compile
   * — sits between app and execution in the precedence ladder, so a
   * session-level tool overrides an app-level tool of the same name
   * but is itself overridden by an execution-level or compiler-
   * emitted tool of the same name.
   *
   * @see ToolBinding in `@agentick/spec` for the precedence ladder.
   */
  readonly tools?: ReadonlyArray<import("../data/declarations.js").ToolDeclaration>;
  /**
   * Initial session-state values (`useSessionState`). Mirrors
   * `initialKnobs` but writes to the StateHarness instead.
   */
  readonly initialState?: Readonly<Record<string, unknown>>;
  /**
   * Parent session id when this session is itself a spawned child.
   * Wired by the spawn flow; rarely supplied directly by adopters.
   */
  readonly parentSessionId?: string;
}

export interface RunOnceInput<P = unknown> {
  /** What to send to the ephemeral session. */
  readonly send: SendInput<P>;
  /**
   * Initial component props for the ephemeral session. Merges with
   * (and overrides) the app-level `initialProps`.
   */
  readonly initialProps?: P;
  /** Optional metadata applied to the ephemeral registry entry. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * If supplied, the ephemeral session is registered with this id; the
   * default behavior generates one. Useful when the caller needs to
   * observe events by sessionId before the result resolves.
   */
  readonly sessionId?: string;
  /** Override the app-level default `maxTicks`. */
  readonly maxTicks?: number;
}

export interface RunOnceResult {
  readonly result: SendResult;
  /** The ephemeral session id used for this run. */
  readonly sessionId: string;
}

// ============================================================================
// Session registry types
// ============================================================================

export interface SessionEntry {
  readonly id: string;
  readonly status: SessionStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly lastActiveAt?: number;
}

export type SessionListEntry = SessionEntry;

export interface SessionFilter {
  readonly status?: SessionStatus | ReadonlyArray<SessionStatus>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Telemetry Layer slot (4f.7 placeholder)
// ============================================================================

/**
 * Optional Effect `Layer` provided to `AppHarnessOptions.telemetry`.
 * When set, app-level commands should run inside this Layer's runtime
 * so the substrate's `Effect.withSpan` annotations + future
 * `Effect.Metric` registrations flow to the configured exporter
 * (OpenTelemetry SDK, custom backend, etc.).
 *
 * Slot is defined now so adopters can pass a Layer through a stable
 * API. **Actual Layer-application requires the AppHarness runtime
 * refactor (deferred)** — passing a Layer today is accepted and
 * stored, but its services aren't applied to running commands yet.
 *
 * `[V1-INHERITED]` shape from v1's `AppOptions.telemetry`.
 */
export type TelemetryLayer = Layer.Layer<never, never, never>;

/**
 * Config form of the `telemetry` switch (telemetry rung 1). Turns on the
 * framework's enrichment defaults AND (optionally) carries the tracer Layer.
 * All fields optional — `{}` is "enrichment on, wire your own exporter".
 */
export interface TelemetryOptions {
  /**
   * Logical service name, stamped as `<ns>.service_name` on every span. An
   * OTel resource-level identity, surfaced here so it rides the enrichment
   * without the adopter hand-building a resource.
   */
  readonly serviceName?: string;
  /**
   * Static attributes stamped on every span (construction-time seam). An open
   * bag — a new dimension is a new key, never a framework change. Merged under
   * the framework's own enrichment (deployment tags: region, tenant, build).
   */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /**
   * The tracer runtime Layer (exporter wiring) — the same value the bare
   * {@link TelemetryLayer} form accepts. Supply it to actually EXPORT spans
   * (e.g. `@effect/opentelemetry`'s `NodeSdk` layer); omit to enrich spans on
   * the default (no-op) tracer while wiring the exporter globally elsewhere.
   *
   * The substrate-native escape hatch (ADR-42 dichotomy). Prefer the
   * standard-OTel {@link spanProcessor} / {@link metricReader} fields — no
   * Effect import required. When both a `layer` and `spanProcessor`s are
   * supplied they compose ADDITIVELY (both export); the `layer` is never
   * overridden.
   */
  readonly layer?: TelemetryLayer;
  /**
   * Standard OpenTelemetry span processor(s) — the de-Effected span export
   * seam. The framework wraps these into a tracer runtime (via
   * `@effect/opentelemetry`) so `Effect.withSpan` operation spans AND
   * `ctx.trace` child spans export to them, with NO adopter-facing Effect
   * import. A raw `new BatchSpanProcessor(new OTLPTraceExporter())` IS the
   * whole wiring. Sampling / filtering / batching stay expressed as standard
   * OTel objects — the framework adds no proprietary layer between adopter and
   * OTel.
   */
  readonly spanProcessor?: SpanProcessor | SpanProcessor[];
  /**
   * Standard OpenTelemetry metric reader(s) — the metrics export seam. The
   * framework feeds these to an OTel `MeterProvider` behind the `MetricSink`
   * seam so `ctx.metrics.*` emissions export to them. Metrics do NOT ride
   * Effect (no Layer) — a `new PeriodicExportingMetricReader({ exporter })` IS
   * the whole wiring.
   */
  readonly metricReader?: MetricReader | MetricReader[];
  /**
   * Opt out of env-driven exporter autodiscovery (default ON when enrichment
   * is on). When enrichment is on and NO exporter is wired (`layer` /
   * `spanProcessor` / `metricReader` all absent), the framework attempts an
   * OTLP exporter from `@agentick/telemetry-otlp` — but ONLY when
   * `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set (a deliberate divergence
   * from the OTel SDK's silent-localhost default: no export spam). Set `false`
   * to suppress that attempt even when the endpoint env is present.
   */
  readonly autoDiscover?: boolean;
}

/**
 * A telemetry DESTINATION bundle — standard OpenTelemetry span processor(s)
 * and/or metric reader(s) plus optional resource attributes. A raw object
 * literal IS a valid sink (the escape hatch is the primitive):
 * `{ spanProcessor: new BatchSpanProcessor(exporter) }`. Sink factories
 * (`otlpSink()`, `spyTelemetrySink()`) return this shape.
 *
 * `createTelemetry(options, ...sinks)` merges sinks into one
 * {@link TelemetryOptions} (span processors concat, metric readers concat,
 * attributes merge under the options'). The framework wraps NOTHING around the
 * OTel objects — sampling / filtering / batching are the adopter's standard
 * OTel objects, passed straight through.
 */
export interface TelemetrySink {
  readonly spanProcessor?: SpanProcessor | SpanProcessor[];
  readonly metricReader?: MetricReader | MetricReader[];
  /**
   * Resource-level attributes contributed by this destination (e.g. an
   * exporter's `service.name` / deployment tags). Merged under the
   * `createTelemetry` options' `attributes` (explicit options win on key
   * collision).
   */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * The `createApp({ telemetry })` switch (telemetry rung 1) — STRICTLY OPT-IN
 * (no ambient auto-on). Three forms, all turning enrichment ON:
 *
 *   - `true` — enrichment on; no exporter (spans annotate the no-op tracer
 *     unless one is wired globally). The zero-config single-switch.
 *   - a {@link TelemetryLayer} — enrichment on + this tracer Layer (the
 *     original form; `telemetry: NodeSdk.layer(...)`).
 *   - a {@link TelemetryOptions} — enrichment on + `serviceName` / `attributes`
 *     / standard-OTel `spanProcessor` / `metricReader` / optional Effect
 *     `layer`. Build it ergonomically with `createTelemetry(options, ...sinks)`.
 *
 * `false` / omitted → OFF: no runtime, no interceptors, zero overhead.
 */
export type TelemetrySetting = TelemetryLayer | boolean | TelemetryOptions;

// Persistence: currently expressed via the existing
// `AppHarnessOptions.journal` slot — supply a durable
// `OperationJournal` impl (e.g., `SqlitePersistenceJournal` once
// shipped) and operational state persists. **Session-state
// persistence** (timeline durability, knob restore, hibernate/restore)
// arrives as a separate slot when the SessionStore protocols land.

// ============================================================================
// Errors
// ============================================================================

/**
 * Migrated to class hierarchy under `AgentickError` — ADR 41 cluster 2.
 * Re-exports from `../errors/lifecycle.js` so existing import paths
 * keep working. New code SHOULD import from `@agentick/spec/errors`.
 */
export {
  AppClosedError,
  AppError,
  type AppErrorChannel,
  AppExecutionFailed,
  SessionNotFoundError,
} from "../errors/lifecycle.js";

// ============================================================================
// AppHarnessProtocol
//
// Note: construction options (`AppHarnessOptions`) carry the JSX root
// element and React-specific defaults and live in the implementation
// package (`@agentick/app`). The spec stays React-agnostic.
// ============================================================================

/**
 * The user-facing app surface. Implementations are expected to extend
 * `BaseHarness<"app">` for the substrate phase contract; the methods
 * below are Promise-typed at the boundary and run on the substrate via
 * `runHarnessProtocol`.
 */
export interface AppHarnessProtocol<P = unknown> {
  /**
   * Stable app identifier. Set at construction (from
   * `AppHarnessOptions.appId` or generated as `app:${ulid()}`); never
   * changes. Adopters use this to discriminate apps in cross-app
   * observation, route gateway-level calls, and persist app-scoped
   * data.
   */
  readonly id: string;

  /**
   * Create a session — **idempotent open-or-rehydrate (ADR 49)**. A
   * fresh id constructs a session (mounting the configured agent JSX,
   * registering in the app's session registry, hydrating from the
   * timeline store when one is configured). An id that is already live
   * returns the existing session — the same call is create AND resume,
   * which is what stateless-replica deployments need; the open call's
   * other options are ignored for an existing session.
   *
   * @throws {AppError} `AppClosedError` if the app is shutting down.
   */
  createSession(input?: CreateSessionInput<P>): Promise<SessionHarnessProtocol<P>>;

  /**
   * Convenience: create an ephemeral session, run one `send`, and close
   * the session when the result resolves. Returns the final
   * `SendResult` along with the (now-closed) session id.
   *
   * The session is registered for the duration of the call; observers
   * subscribed to `app.events({ scope: { sessionId } })` see its
   * envelopes. After `runOnce` resolves, the registry entry is removed.
   */
  runOnce(input: RunOnceInput<P>): Promise<RunOnceResult>;

  /**
   * Look up a LIVE session by id — the in-memory routing handle. Returns
   * `undefined` if no session with that id is currently live (a closed session
   * is dropped from the live registry, but its durable {@link SessionRecord}
   * survives in the store — read it via {@link getSessionRecord}).
   *
   * This is the **live-registry** half of the E11 split: `sessionId → live
   * SessionHarness` (routing, ephemeral). {@link listSessions} /
   * {@link getSessionRecord} are the **record-store** half (durable metadata,
   * the superset).
   */
  getSession(sessionId: string): SessionHarnessProtocol<P> | undefined;

  /**
   * Enumerate the durable session registry — the {@link SessionStore} (E11).
   * Returns {@link SessionRecord}s (the superset: every non-ephemeral session
   * ever, including closed ones the live registry dropped), filtered by app /
   * status / parent / recency. This — not the live registry — is the backing
   * for every "list / resume my sessions" surface.
   */
  listSessions(query?: SessionStoreQuery): Promise<readonly SessionRecord[]>;

  /**
   * Read one durable {@link SessionRecord} by id from the {@link SessionStore}
   * (E11) — the durable superset, so a closed / historical session (absent from
   * the live registry) still resolves. `undefined` when unknown.
   */
  getSessionRecord(sessionId: string): Promise<SessionRecord | undefined>;

  /**
   * Set the app-owned descriptive slots (`title` / `description` / `metadata`)
   * on a session's durable {@link SessionRecord} (E11). These are the app's to
   * populate (auto-summary, user-edit, the open over-fetch bag) — the framework
   * STORES them and is blind to their semantics. No-op when the session is not
   * live.
   */
  setSessionMeta(
    sessionId: string,
    meta: {
      readonly title?: string;
      readonly description?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<void>;

  /**
   * Cross-session event subscription. Returns an `AsyncIterable` over
   * `ProtocolEvent` envelopes matching the filter. Every event from
   * every session, sub-harness, and the app itself flows through —
   * filter via the `EventQuery` (by surface, name prefix, phase,
   * outcome, or scope.sessionId).
   *
   * The iterable defaults to *live* — yields envelopes appended AFTER
   * the subscription opens. Pass `options.fromCursor` to start at an
   * older cursor (e.g., resume from a previously persisted position).
   * `{ value: 0 }` replays everything still retained.
   *
   * If the supplied cursor is older than the bus's retained range, the
   * iterable throws `CursorEvictedError` before yielding any event.
   * Adopters who want skip-ahead semantics catch and resubscribe with
   * the error's `oldestAvailable` cursor.
   *
   * Multiple subscribers are independent (the substrate bus is
   * multi-subscriber by design). Breaking out of the `for await`
   * cleanly unsubscribes.
   */
  events(filter?: EventQuery, options?: SubscribeOptions): AsyncIterable<ProtocolEvent>;

  /**
   * Close every open session, release shared resources (compiler
   * mounts, loop-executor in-flight aborts, executor abort signals),
   * and emit `app:lifecycle:closed`. Subsequent calls reject with
   * `AppClosedError`.
   */
  closeApp(): Promise<void>;

  // ──────────────────────────────────────────────────────────────────
  // App-level extensibility (block 5 — α design)
  //
  // - `app.use(middleware)` is inherited from BaseHarness. Wraps app
  //   commands that go through `runOperation`. Note: createSession /
  //   runOnce / closeApp do NOT route through runOperation today, so
  //   middleware on those is registered but silently no-op until those
  //   commands are refactored. Lifecycle hooks below are functional.
  // - `app.events(filter)` (already on the protocol) is the observer
  //   surface — async-iterable subscription. No separate observers
  //   namespace; use `app.events()` directly.
  // - `app.services` is a simple key/value registry for app-level
  //   singletons (renderer registries, telemetry exporters, custom
  //   integrations). Sessions and tools look them up by token.
  // - Lifecycle hooks (`onSessionCreate` / `onSessionClose` /
  //   `onAppClose`) attach handlers that fire at the named boundary.
  //   Handlers can return `HandlerVerdict` (veto/replace/defer/proceed)
  //   to influence behavior.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Service registry — store and retrieve app-level singletons by
   * string token. Sessions and tools can read these as ambient
   * capabilities (telemetry exporters, custom registries, etc.).
   */
  readonly services: ServiceRegistry;

  /**
   * Register a handler that fires before a new session is created.
   * Handler can return a `HandlerVerdict` to veto (refuse the session)
   * or replace (substitute a pre-built session). Multiple handlers
   * compose per `mergeVerdict`.
   */
  onSessionCreate(
    handler: (
      input: CreateSessionInput<P>,
    ) => Promise<{ readonly kind: "veto"; readonly reason?: string } | void>,
  ): () => void;

  /**
   * Register a handler that fires when a session closes (via
   * `closeApp` or auto-dispose from `runOnce`). Handler is informational
   * — return value is ignored. Use for cleanup / analytics flush.
   */
  onSessionClose(
    handler: (info: {
      readonly sessionId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }) => Promise<void> | void,
  ): () => void;

  /**
   * Register a handler that fires when `closeApp` is called, before
   * sessions are torn down. Informational — return value is ignored.
   */
  onAppClose(handler: () => Promise<void> | void): () => void;
}

/**
 * Key/value service registry. Type-safe via the caller's annotation
 * at lookup time — `app.services.get<MyService>("token")`.
 */
export interface ServiceRegistry {
  register<T>(token: string, instance: T): () => void;
  get<T>(token: string): T | undefined;
  has(token: string): boolean;
}

// Re-export the executor types so consumers of @agentick/spec can
// satisfy AppHarnessOptions without reaching into other entrypoints.
export type { ExecutorFactory, ExecutorProtocol, LanguageModelExecutor };
export type { SendInput, SendResult, SessionExecutionHandle, SessionHarnessProtocol };
