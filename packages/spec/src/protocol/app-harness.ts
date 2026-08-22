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
import type { IngressIdentity } from "../wire/authorizer.js";
import type { IdentityScoped } from "./identity.js";
import type { ModelFacts } from "../data/model-facts.js";
import type { SessionStatus } from "./hook-bridges.js";
import type { SessionRecord, SessionStoreQuery } from "./session-store.js";
import type { CursorPage, PageRequest } from "./paging.js";
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
   * Construction-bound owning principal (ADR 48) — the identity axis of the
   * session's structural identity, stamped onto the {@link SessionHarnessProtocol}
   * and the durable {@link SessionRecord}, and read by the wire dispatch gate for
   * the same-principal target rule (ADR 51 §4.2).
   *
   * HOST-door settable only — server-declared, deliberately NOT settable over
   * the wire (exactly like {@link requiredScopes}). The framework's
   * `app/create_session` wire method stamps this from the authenticated
   * caller's identity (`ctx.principal`); the wire params type carries NO
   * `principal` field, so a value smuggled in the request body is ignored.
   * A spawned / forked child inherits its parent's principal (the spawn flow
   * threads it through `SpawnContextChildInput.principal`); ownership is not
   * caller-choosable.
   */
  readonly principal?: string;
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
   * `app.setSessionMeta(sessionId, ...)`.
   *
   * WHO answered is not among them: a session's answering identity is its `appId`,
   * joined to that app's `title`. Denormalizing a name onto the record would make
   * renaming an app a data migration and freeze every historical thread under the
   * old label — the opposite handling from `boundary.target`, which IS evidence
   * about a past turn and must not move.
   */
  readonly title?: string;
  readonly description?: string;
  /**
   * Persist the durable `SessionRecord` (E11) at genesis rather than on the
   * first mutation. Default `false` — creating a session seeds its state but
   * writes NOTHING durable, so a "new chat" the user never speaks into leaves
   * no blank row in the "list my sessions" registry; the first `send` /
   * `setSessionMeta` performs the first write. Set `true` when the empty
   * session must appear in the durable list immediately (e.g. a client that
   * renders the row before the first message).
   */
  readonly eager?: boolean;
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

/**
 * Options for {@link AppHarnessProtocol.destroySession}. Deliberately thin —
 * destroy has no policy knobs. What deletion MEANS durably is the
 * {@link SessionStore} impl's call (soft vs hard is adopter policy), not a flag
 * here.
 */
export interface DestroySessionInput {
  /**
   * Reason threaded into the abort of every live execution in the destroyed
   * subtree, so the cancellation is attributable in the journal / terminal
   * result. Defaults to `"destroyed"`.
   */
  readonly reason?: string;
}

/**
 * What {@link AppHarnessProtocol.destroySession} actually did — normalized to
 * the facts the app holds AT ACT TIME, and nothing more. Every field is
 * observed, not inferred: no field claims knowledge the store impl owns.
 *
 * Idempotent by construction: destroying an unknown id succeeds with
 * `live.found === false` and `record.existed === false` (silence, not a fault).
 */
export interface DestroySessionResult {
  /** The id destroy was asked to remove. Echoed so a batch caller can correlate. */
  readonly sessionId: string;
  /** The LIVE plane — the in-memory registry, executions, and task executors. */
  readonly live: {
    /** Was the session in the app's live registry when destroy ran? */
    readonly found: boolean;
    /**
     * How many sessions in the destroyed subtree (the target plus its live
     * descendants) had an in-flight execution when destroy aborted them. A
     * session runs at most one execution, so this is a count of sessions, and
     * it is what destroy OBSERVED — not a promise that each abort landed before
     * the execution would have finished on its own.
     */
    readonly abortedExecutions: number;
    /**
     * Live descendants torn down with the target — the transitive spawn subtree
     * as the registry knew it at act time. Excludes the target itself. Their
     * store scopes and durable records are deleted along with the target's.
     */
    readonly disposedDescendants: number;
    /**
     * Detached tasks cancelled across the destroyed subtree. These are exactly
     * the tasks `close()` deliberately ABANDONS (ADR 68) — destroy is the
     * stronger verb, so it reaps them. Counts only tasks reachable through a
     * LIVE session's task harness; a detached task whose owning session was
     * already closed has no in-process handle for the app to cancel through.
     */
    readonly cancelledDetachedTasks: number;
  };
  /** The DURABLE plane — the {@link SessionStore} record. */
  readonly record: {
    /**
     * Did a durable {@link SessionRecord} exist for this id when destroy ran?
     * The honest half of "was anything deleted": destroy always calls
     * `SessionStore.delete(sessionId)` (unconditionally, so a record written
     * between the read and the delete is not left behind), and what that
     * deletion MEANS — soft flag, hard row removal, cascade to children — is
     * the store impl's contract, not a fact this result can assert.
     */
    readonly existed: boolean;
  };
}

/**
 * Options for {@link AppHarnessProtocol.abortExecutionTree}. As thin as
 * destroy's, and for the same reason: the verb has one job.
 */
export interface AbortExecutionTreeInput {
  /**
   * Reason threaded into each abort, so the cancellation is attributable in the
   * journal and in the terminal result. Defaults to
   * `"origin execution aborted"`.
   */
  readonly reason?: string;
}

/**
 * What {@link AppHarnessProtocol.abortExecutionTree} actually did — facts
 * observed at act time, in the shape a supervisor needs next: it names the
 * sessions it cancelled, because the caller's next move (inspect them, destroy
 * them, report them) needs their ids and the app will not hand them back twice.
 */
export interface AbortExecutionTreeResult {
  /** The execution whose fan-out was cancelled. Echoed for correlation. */
  readonly executionId: string;
  /**
   * The live sessions whose executions were aborted — the origin execution's
   * spawned children and their whole live subtrees, deepest-first (the order
   * the aborts were issued in). Excludes the origin session itself; see
   * {@link originAborted}.
   */
  readonly sessionIds: readonly string[];
  /**
   * Was the origin execution itself still running, and therefore aborted too?
   * `false` is the normal case for the verb's reason to exist: the turn already
   * settled and only its fan-out is still alive.
   */
  readonly originAborted: boolean;
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
  /**
   * ADR 48 — the owning principal stamped onto the ephemeral session, same
   * field and semantics as {@link CreateSessionInput.principal}. An ephemeral
   * session is still a session: attribution-aware stores and the wire
   * dispatch gate read the stamp regardless of lifetime.
   */
  readonly principal?: string;
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
  /**
   * The app-owned descriptive slots off the durable record — the THREAD's title and
   * blurb (auto-summary, user-edit), which a session list needs one of per row and
   * cannot get any other way.
   *
   * No `appId` here, deliberately: a client reaches sessions THROUGH an app handle
   * (`app.listSessions()`, `app/get_session` takes an `appId`), so it already knows
   * which app answered and joins that app's `title` itself.
   */
  readonly title?: string;
  readonly description?: string;
  /**
   * The parent session, when this one was SPAWNED. Absent on a root.
   *
   * A client filters roots with `SessionFilter.root`, but a client that lists
   * everything still has to tell them apart — to nest a sub-session under the turn
   * that opened it, or to mark a row as an agent's own work rather than a
   * conversation.
   */
  readonly parentSessionId?: string;
}

export type SessionListEntry = SessionEntry;

export interface SessionFilter {
  readonly status?: SessionStatus | ReadonlyArray<SessionStatus>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * `true` lists only ROOT sessions — what a conversation list wants.
   *
   * A spawned child is a real session with a real durable record, so without this a
   * sub-agent's working session appears in the user's thread list beside
   * conversations they actually had. Named `root` rather than expressed as
   * `parentSessionId: null` because a wire filter is read by callers who did not
   * write it, and an accidental `null` silently narrowing a list to roots is a
   * worse failure than one extra field.
   */
  readonly root?: boolean;
  /**
   * Children of exactly this session — the other half of the tree, and what a
   * session-GRAPH view asks for once a thread is open.
   *
   * The store has had this dimension all along; the wire did not project it, so a
   * client could exclude sub-sessions from a list but never enumerate the ones
   * belonging to a turn. Contradictory with `root: true` (nothing has both no
   * parent and a specific one) — supplying both matches nothing rather than
   * silently preferring one.
   */
  readonly parentSessionId?: string;
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
/**
 * An app handle scoped to an authenticated identity — the return of
 * {@link AppHarnessProtocol.as}.
 *
 * The bare local pole (`app.createSession(...)`) is the trusted host talking to
 * its own composition: whatever `principal` the caller supplies is taken at its
 * word, and nothing checks the work. This handle is the other stance — "act as
 * this identity": the ADR-48 `principal` stamp is DERIVED from the identity
 * rather than hand-assembled, clobbering anything the input claims (the
 * identity is the authority, exactly the wire rule), and the identity rides
 * the op scope so hooks on the create op can read WHO is acting.
 *
 * Attribution only, at this level — an app alone has no authorizer and no
 * gateway hook bag. The policy-bearing twin is
 * {@link GatewayHarnessProtocol.as}, which routes the same calls through the
 * wire dispatch seam first.
 */
export interface IdentityScopedApp<P = unknown> extends IdentityScoped {
  /** {@link AppHarnessProtocol.createSession}, principal-stamped from the identity. */
  createSession(input?: CreateSessionInput<P>): Promise<SessionHarnessProtocol<P>>;
  /** {@link AppHarnessProtocol.runOnce}, principal-stamped from the identity. */
  runOnce(input: RunOnceInput<P>): Promise<RunOnceResult>;
}

export interface AppHarnessProtocol<P = unknown> {
  /**
   * Stable app identifier. Set at construction (from
   * `AppHarnessOptions.appId` or generated as `app:${generateId()}`); never
   * changes. Adopters use this to discriminate apps in cross-app
   * observation, route gateway-level calls, and persist app-scoped
   * data.
   */
  readonly id: string;

  /**
   * Display label for this app — what a person reads. `id` is what a client
   * routes on; this is what it renders. Optional: an app that never faces a
   * person needs none, and a client falls back to `id`.
   *
   * WHO answered in a session resolves through here: `SessionRecord.appId` joined
   * to this. Deliberately a live join rather than a name copied onto each record —
   * renaming an app should relabel its threads, which a durable copy would prevent
   * (the opposite of `boundary.target`, which is evidence about a past turn and
   * must not move).
   */
  readonly title?: string;

  /** One line on what this app is, for a picker or a catalog. */
  readonly description?: string;

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
   * Act as an authenticated identity — see {@link IdentityScopedApp}.
   *
   * Trust contract: this method does NOT authenticate. The identity is
   * whatever the caller hands it — verify the credential first (an
   * `AuthSource` is the door for that); from here on, correct stamping is the
   * framework's job.
   */
  as(identity: IngressIdentity): IdentityScopedApp<P>;

  /**
   * Remove a session — the STRONGEST form, and the transitive one.
   *
   * `close()` is the gentle verb: the session ends, its durable
   * {@link SessionRecord} survives as history, and its DETACHED tasks keep
   * running by contract (ADR 68). `destroySession` is the other end: the
   * session and its live spawn subtree are torn down, the work they were doing
   * is cancelled, and the durable record AND every per-harness store scope are
   * deleted.
   *
   * In order:
   *   1. **Abort in-flight executions transitively.** `session.abort()` reaches
   *      only that session's own current execution — a spawned child feels the
   *      parent's construction signal but is not itself aborted by it — so
   *      destroy walks the live spawn subtree and aborts each descendant.
   *   2. **Cancel detached tasks** across the subtree. This is precisely what
   *      `close()` abandons; destroy is stronger, so it reaps them.
   *   3. **Drop every store scope** — each {@link DropCapable} bridge deletes
   *      its OWN scope in its OWN store (timeline log, knob and state
   *      partitions), across the subtree, while the bridges are still mounted.
   *      Without this the record goes and the conversation stays, and the next
   *      session created with that id hydrates it back (checkpointing §6). A
   *      failed drop fails the destroy.
   *   4. **Dispose the subtree** through the same teardown a genuine session end
   *      uses (`onSessionClose` fires, live registry entries drop).
   *   5. **Delete the durable records** — the target's and every torn-down
   *      descendant's, via `SessionStore.delete`.
   *
   * A target that is not live is REBUILT first, from its durable record through
   * the same recovery path a send would take: only a live harness can name its
   * own scopes.
   *
   * **Idempotent.** An unknown / already-destroyed id is SUCCESS, not a fault:
   * the result simply reports `live.found === false` and
   * `record.existed === false`. Callers get facts, not exceptions, for the
   * "already gone" case.
   *
   * A descendant the LIVE registry cannot see (already evicted, or parented to a
   * session that is gone) is out of reach of the walk; whether a deleted parent
   * cascades to its rows is the store impl's decision (a SQL `ON DELETE CASCADE`
   * is exactly where that policy belongs), not the framework's.
   */
  destroySession(sessionId: string, opts?: DestroySessionInput): Promise<DestroySessionResult>;

  /**
   * Cancel what ONE execution spawned — the sessions it created, their
   * descendants, and (if it is somehow still running) the execution itself.
   *
   * The scope is an EXECUTION, not a session: a long-lived session runs many
   * turns, and turn N's sub-agents are not turn N+1's business. The walk keys
   * off {@link SessionRecord.originExecutionId}, the edge every spawn stamps —
   * the target execution's direct children, then each of their whole live
   * subtrees, because once a branch belongs to the cancelled turn, everything
   * under it does too (including work a lineage session spawned from a later
   * execution of its own).
   *
   * **Why this exists when the live case is already covered.** A spawn inherits
   * its origin execution's abort signal, so aborting a RUNNING execution
   * already tears down the children it spawned — no walk needed. This verb is
   * for the other case: the execution SETTLED (successfully — a failed or
   * cancelled one fired that same signal), the caller kept the sub-agents it
   * spawned, and now wants them gone. There is no live signal left to fire; the
   * durable origin edge is the only thing that still knows what belonged to
   * that turn.
   *
   * Abort-strength only, and deliberately: sessions are cancelled, never
   * disposed and never deleted. It is `abort({ cascade: true })` addressed by
   * execution instead of by session — see {@link SessionAbortOptions} for the
   * ladder. Idempotent and quiet: an unknown / already-settled execution with
   * no live fan-out reports an empty `sessionIds`.
   */
  abortExecutionTree(
    executionId: string,
    opts?: AbortExecutionTreeInput,
  ): Promise<AbortExecutionTreeResult>;

  /**
   * Is `sessionId` inside the spawn tree of `executionId`? The same membership
   * {@link abortExecutionTree} computes, answered from the other end.
   *
   * `abortExecutionTree` walks DOWN: seed on the entries stamped with this
   * origin execution, then take each seed's whole live subtree. That shape
   * suits a one-shot fan-out over a registry snapshot. A subscriber filtering a
   * live event stream has the opposite problem — one session id per event,
   * arriving continuously — so it walks UP instead: from the session, follow
   * the `parentSessionId` chain and answer `true` at the first ancestor (the
   * session itself included) whose `originExecutionId` is the target. Same
   * predicate, same edges, O(depth) per call and no snapshot.
   *
   * The canonical caller is the gateway's execution-scoped progress fan
   * (`session/send` with `fanIn`): descendant signals carry their OWN
   * execution id, so the execution-id equality that matches the root turn's
   * own signals cannot see them, and this answers "does this session's work
   * belong to the turn I am streaming?".
   *
   * Deliberately NOT membership in a session's spawn subtree — the question is
   * scoped to ONE TURN. A session whose lineage reaches the target execution is
   * in, including work it started from a later execution of its own; a sibling
   * turn's descendants (and the origin session's own later turns) are out,
   * which is what keeps two concurrent executions on one session from seeing
   * each other's signals.
   *
   * Reads the LIVE registry only, so a paged-out ancestor breaks the chain and
   * its descendants report `false` — the same limitation
   * {@link abortExecutionTree}'s walk has, and for the same reason (the durable
   * `SessionRecord` carries the edge, but resolving it would make a per-event
   * predicate do store reads).
   */
  executionTreeContains(executionId: string, sessionId: string): boolean;

  /**
   * Is `sessionId` inside the live spawn tree rooted at `rootSessionId`? The
   * same O(depth) `parentSessionId` climb {@link executionTreeContains} makes,
   * asking the OTHER membership question — and the difference between them is
   * not a detail, it is the whole point of having both.
   *
   * **An execution id names a turn a session moves past; a session id names the
   * session itself.** So `executionTreeContains(e, s)` answers `false` for the
   * session that STARTED execution `e` (its own later turns are not that turn's
   * business), while `sessionTreeContains(r, r)` answers `true`: the root IS a
   * member of its own tree. Watching a session's tree that excluded the session
   * would be a subscription nobody wants.
   *
   * Membership is LINEAGE, not turn: a descendant belongs whether it was
   * spawned by turn 1 or turn 40, and it keeps belonging after the turn that
   * spawned it settles. That is what makes this the right predicate for a
   * SUBSCRIPTION, which outlives any one execution, where
   * {@link executionTreeContains} is the right one for a turn's progress fan.
   *
   * The canonical caller is the gateway's `session-tree` subscription scope:
   * one emitting session id per event, arriving continuously, so it climbs from
   * the emitter rather than snapshotting the tree.
   *
   * Reads the LIVE registry only, with the same limitation stated the same way:
   * a paged-out intermediate ancestor breaks the chain and its descendants
   * report `false`. Cycle-guarded — a corrupt parent edge must not hang a
   * per-event predicate.
   */
  sessionTreeContains(rootSessionId: string, sessionId: string): boolean;

  /**
   * The live spawn tree rooted at `rootSessionId`, ROOT FIRST then
   * breadth-first — the enumeration half of {@link sessionTreeContains}.
   *
   * A subscriber needs the membership predicate per event and this list ONCE,
   * at subscribe time, to splice each member's current channel snapshots in
   * before the live tail (root's board first, then its children's — the order a
   * late joiner wants to render). Returns ids only: the caller reaches the
   * session through {@link getSession}, and a list of ids cannot go stale in a
   * way that a list of harness references would hide.
   *
   * Live registry only, so it is a point-in-time answer by construction — a
   * session spawned a millisecond later is not in it and needs no retro-splice,
   * because its channels emit as they populate.
   */
  sessionTree(rootSessionId: string): readonly string[];

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
   * Bring a session back — the door for a caller holding only an id, when the
   * live registry has none.
   *
   * `getSession` answers "is this mounted"; this answers "can this be mounted
   * again, and if so, mount it." There is ONE way it does so, whether the
   * session was evicted a second ago or the process restarted since: a durable
   * {@link SessionRecord} whose status is not terminal is rebuilt from the app's
   * recipe, and each of its harnesses rehydrates from its own store.
   *
   * What survives is therefore exactly what the record and the stores hold. A
   * resumed session is NOT byte-identical to the original create call: the root
   * element and props come from the app, and per-session construction arguments
   * (extra tools, the scope ceiling) are not persisted.
   *
   * `undefined` for an id this app cannot bring back: never opened here, or
   * genuinely over (closed / completed / failed). Resume never CREATES — an
   * unknown id resolves to nothing rather than a blank session, which is what
   * lets the wire tell "evicted" apart from "no such session".
   *
   * Concurrency-safe: same-id calls collapse onto one construction, so two sends
   * arriving together against an evicted session remount it once.
   *
   * REJECTION SEMANTICS — the honest oddity: if an `onInterruptedExecution` policy
   * throws (execution-resume.md §3.2), this REJECTS, but the rejection signals the
   * POLICY failed, not the resume. The session already opened, is live, and a retry
   * returns it (the mark + build ran before the callback). Side-effect-persisted-
   * despite-reject is deliberate — the same posture as a rejected persist leaving an
   * evict retryable. A throwing policy forfeits only this boot's automatic re-drive;
   * the interruption history survives for a manual resume.
   */
  resumeSession(sessionId: string): Promise<SessionHarnessProtocol<P> | undefined>;

  /**
   * Check a live session out of memory — the public counterpart of
   * {@link resumeSession}, and the same composed operation the idle sweep and
   * the `maxActive` LRU run: flush every harness to its own store
   * (`session:snapshot`), then `session:close({ reason: "evicted" })` and
   * unmount. The app retains nothing; the next {@link resumeSession} /
   * same-id `createSession` rebuilds from the record + stores.
   *
   * Configuration (`sessions.idleTimeout` / `sessions.maxActive`) governs the
   * automatic callers only. This is the manual one — for a host that knows a
   * session is done being active (a UI tab closed, a shift ended) and wants the
   * memory back before the sweep would take it.
   *
   * **Resolves without effect** for an id that is not live, is ephemeral, or has
   * an execution IN FLIGHT — the last is the hard eviction invariant, identical
   * to what the sweep does when it meets a busy session, and expressing it as a
   * refusal would make every caller write the same retry loop. Poll
   * {@link getSession} if you need to know it happened.
   *
   * Rejects only if a harness's flush fails; the session then stays live, since
   * an unmount behind an un-flushed tail would lose data.
   */
  evictSession(sessionId: string): Promise<void>;

  /**
   * End a session and drop it from the live registry — the app-door twin of
   * `session.close()`, and the one every remote / non-owner caller should use.
   *
   * Closing the harness directly ends the session but leaves the app holding a
   * dead entry: `getSession` keeps handing it back, the LRU cap keeps counting
   * it, and `createSession` with the same id returns the corpse. This verb runs
   * the same teardown with the registry bookkeeping attached.
   *
   * Reaches a session that is only PAGED OUT as well: the paged state is
   * dropped and the durable record is stamped closed, so a hibernated session
   * can be ended without first bringing it back.
   *
   * Idempotent — an unknown or already-closed id is success, not a fault. The
   * durable {@link SessionRecord} survives as history (use
   * {@link destroySession} to delete it).
   */
  closeSession(sessionId: string): Promise<void>;

  /**
   * Enumerate the durable session registry — the {@link SessionStore} (E11).
   * Returns {@link SessionRecord}s (the superset: every non-ephemeral session
   * ever, including closed ones the live registry dropped), filtered by app /
   * status / parent / recency. This — not the live registry — is the backing
   * for every "list / resume my sessions" surface.
   */
  listSessions(query?: SessionStoreQuery): Promise<readonly SessionRecord[]>;

  /**
   * One PAGE of the same durable registry {@link listSessions} snapshots — the
   * read every remote "list my sessions" surface actually wants.
   *
   * Delegates to `SessionStore.page` when the configured store implements that
   * optional cursored read, so paging reaches the backend and the store mints
   * the cursor. When it does not, this falls back to snapshotting the query and
   * cutting the page in process with the framework's default keyset — correct,
   * and the reason a store with a hundred thousand threads should implement
   * `page`.
   *
   * The two paths are indistinguishable to a caller: same envelope, same opacity
   * of cursor. Only the cost differs.
   *
   * Scope the read with `query.principal` rather than filtering the returned
   * page — a filter applied after the cut shortens the page and leaves a
   * `nextCursor` pointing past rows that were discarded.
   */
  pageSessions(query?: SessionStoreQuery, page?: PageRequest): Promise<CursorPage<SessionRecord>>;

  /**
   * Read one durable {@link SessionRecord} by id from the {@link SessionStore}
   * (E11) — the durable superset, so a closed / historical session (absent from
   * the live registry) still resolves. `undefined` when unknown.
   */
  /**
   * What this app knows about a model — the adopter's `models` registry folded
   * over the seed catalog. `undefined` when no layer describes it; the catalog
   * never fabricates, so "unknown" is an answer rather than a zero.
   *
   * Returns the SERIALIZABLE facts, not the full catalog row: the row carries a
   * `tokenEstimator` function, and this is the shape `app/model_info` hands a
   * client. Keeping the projection here means the gateway needs no knowledge of
   * the model layer to serve it.
   */
  modelInfo(provider: string, modelId: string): ModelFacts | undefined;

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
   * Register a handler that fires before a new session is created. The
   * house before-hook grammar, three arms:
   *   - **veto** — return `{ kind: "veto", reason? }` to refuse the session
   *     (the call throws). First veto wins.
   *   - **reshape** — return a `CreateSessionInput` to REPLACE the input the
   *     rest of construction sees (fold-forward: later handlers and the
   *     session build both observe the reshaped value). This is the adopter
   *     seam for selective spawn inheritance — read `parentSessionId`, look up
   *     the parent record, inject chosen `metadata` keys into the child.
   *   - **pass** — return `void` to leave the input untouched.
   *
   * Handlers run in registration order; a reshape from one is visible to the
   * next. A `{ kind: "veto" }` return is recognized as a veto BEFORE the
   * reshape arm, so it is never mistaken for an input value.
   */
  onSessionCreate(
    handler: (
      input: CreateSessionInput<P>,
    ) => Promise<
      { readonly kind: "veto"; readonly reason?: string } | CreateSessionInput<P> | void
    >,
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
