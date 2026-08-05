/**
 * `GatewayHandle` / `AppHandle` / `SessionHandle` — typed views of a
 * server-side resource over the wire.
 *
 * Mirror the in-process harness protocols (`GatewayHarnessProtocol`,
 * `AppHarnessProtocol`, `SessionHarnessProtocol`) so adopters write
 * the same code regardless of whether they're in-process or remote.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"The developer surface"
 */

import type { EventQuery } from "../data/events.js";
import type { Cursor } from "../protocol/event-log.js";
import type {
  CreateSessionInput,
  DestroySessionInput,
  SessionEntry,
  SessionFilter,
} from "../protocol/app-harness.js";
import type { GatewayDestroySessionResult } from "../protocol/gateway-harness.js";
import type {
  SendInput,
  SendResult,
  SessionAbortOptions,
  SessionExecutionHandle,
} from "../protocol/session-harness.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type {
  GatewayListAppsResult,
  GatewayListSessionsResult,
  AppCreateSessionResult,
  AppDestroySessionResult,
  AppListSessionsResult,
  SessionModelInfoResult,
  AppModelInfoResult,
  AppRunOnceResult,
  SessionPageRequest,
} from "../wire/params.js";
import type { SubscriptionStream } from "./transport.js";
import type { Unsubscribe } from "../protocol/inbox.js";
import type { OnSignalOptions, ReceivedLog, ReceivedProgress } from "./signals.js";
import type { ChannelView, ChannelViewConfig } from "./channel.js";
import type { SessionWireNamespace, WireNamespaceMethods } from "./wire-proxy.js";

// ============================================================================
// Scoped subscriptions — the runtime-signal / channel-view subscriptions
// PRE-SCOPED to the handle's scope, so callers don't repeat `{ kind, id }`.
// `client.session(id).onLog(cb)` is the 90% ergonomic; the generic
// `client.onLog(scope, cb)` on `ClientProtocol` is the escape hatch for a
// scope you don't hold a handle for.
// ============================================================================

export interface HandleSubscriptions {
  /**
   * Subscribe to `log` runtime signals for THIS handle's scope. Pre-scoped
   * twin of `client.onLog(scope, …)`. Returns an {@link Unsubscribe}.
   */
  onLog(handler: (event: ReceivedLog) => void, opts?: OnSignalOptions): Unsubscribe;
  /**
   * Subscribe to `progress` runtime signals for THIS handle's scope.
   * Pre-scoped twin of `client.onProgress(scope, …)`.
   */
  onProgress(handler: (event: ReceivedProgress) => void, opts?: OnSignalOptions): Unsubscribe;
  /**
   * Open a reduced {@link ChannelView} over one `session:channel:<channel>`
   * for THIS handle's scope. Pre-scoped twin of
   * `client.channelView(scope, …)`. `config` is OPTIONAL — omitted, the
   * default fold is last-frame-payload-wins (the view holds the latest
   * frame payload, `undefined` before the first frame).
   */
  channelView<T, F>(channel: string, config: ChannelViewConfig<T, F>): ChannelView<T>;
  channelView<T = unknown>(channel: string): ChannelView<T | undefined>;
}

// ============================================================================
// Common — every handle exposes resource id + event subscription
// ============================================================================

export interface ResourceHandle {
  readonly id: string;
  events(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream;
}

// ============================================================================
// GatewayHandle
// ============================================================================

export interface GatewayHandle extends HandleSubscriptions {
  listApps(): Promise<GatewayListAppsResult>;
  getApp(id: string): Promise<GatewayListAppsResult["apps"][number]>;
  /**
   * Destroy a session without naming its app — the gateway resolves the owner
   * and the result says which app it was. Same verb and same semantics as
   * `app(id).destroySession(...)`; reach for this one when you hold a session id
   * from a cross-app listing and no app id beside it.
   */
  destroySession(
    sessionId: string,
    opts?: DestroySessionInput,
  ): Promise<GatewayDestroySessionResult>;
  /**
   * One page of every session on the gateway, across every app — the
   * enumeration twin of {@link destroySession}'s app-less addressing. Each entry
   * names the `appId` it belongs to, which is what you then call
   * `gateway.app(entry.appId)` with.
   *
   * Scoped to the authenticated caller: another principal's threads are simply
   * not in the page. Walk with the returned `nextCursor` until it is absent —
   * a page can be exactly `limit` long and still be the last one.
   */
  listSessions(
    filter?: SessionFilter,
    page?: SessionPageRequest,
  ): Promise<GatewayListSessionsResult>;
  events(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream;
  app(id: string): AppHandle;
}

// ============================================================================
// AppHandle
// ============================================================================

export interface AppHandle extends ResourceHandle, HandleSubscriptions {
  createSession<P = unknown>(input?: CreateSessionInput<P>): Promise<AppCreateSessionResult>;
  getSession(sessionId: string): Promise<SessionEntry>;
  /**
   * What the SERVER knows about a model — window, output cap, pricing,
   * capabilities. Key it off the `metadata.model` provenance stamped on every
   * assistant entry, so a client never guesses which model produced a turn.
   *
   * Ask, do not derive. The adopter's `models` registry is merged over the seed
   * server-side, so a client resolving from the seed catalog alone would
   * compute a different answer than the server actually used.
   *
   * The reply is STATIC for a given model — cache it for the life of the page
   * and re-fetch only when the provenance changes. There is no push for this:
   * a model change is announced by the next assistant entry carrying a
   * different `metadata.model`, and a second path to one fact is worse than
   * one path that is a turn late.
   */
  modelInfo(provider: string, modelId: string): Promise<AppModelInfoResult>;
  /**
   * One page of this app's durable session registry — the "my threads" read.
   *
   * Returns the PAGE, not a bare array: the reply carries the `nextCursor` that
   * continues the walk, and a caller handed only rows would have no way to ask
   * for the rest. Absent `nextCursor` means the walk is done.
   *
   * Scoped to the authenticated caller — another principal's sessions are absent
   * from the page rather than an error.
   */
  listSessions(filter?: SessionFilter, page?: SessionPageRequest): Promise<AppListSessionsResult>;
  /**
   * The remote twin of `AppHarnessProtocol.destroySession` — strongest-form,
   * transitive removal. `session(id).close()` is the gentle verb (the thread
   * ends, its record survives, detached tasks keep running); this one tears down
   * the live spawn subtree, cancels its detached tasks, and deletes the durable
   * record. Idempotent: an id that is already gone resolves with
   * `live.found === false`.
   */
  destroySession(sessionId: string, opts?: DestroySessionInput): Promise<AppDestroySessionResult>;
  runOnce<P = unknown>(input: SendInput<P>): Promise<AppRunOnceResult>;
  close(): Promise<void>;

  session(sessionId: string): SessionHandle;
}

// ============================================================================
// SessionHandle
// ============================================================================

/**
 * Empty-seed interface for per-harness client sub-handles (ADR 87) — the
 * client-side twin of the server's `HookBridges`. Each harness `/client` package
 * augments this to contribute a typed sub-handle (`session.tasks`, `session.knobs`,
 * …), so the client `SessionHandle` self-assembles from installed harness client
 * packages the same way the server session assembles bridges. Client-core declares
 * NO slots here — they arrive only via `declare module` from the harness packages
 * (which also `registerSessionHandleExtension` the runtime factory).
 *
 * @example
 * // in @agentick/tasks/client:
 * declare module "@agentick/spec" {
 *   interface SessionHandleExtensions { readonly tasks: ChannelView<TaskStatusMap>; }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionHandleExtensions {}

/**
 * What a CLIENT sends: everything the in-process session takes, plus the
 * options that only mean something when a wire is in the middle.
 *
 * The separation is deliberate. {@link SendInput} is the execution's input —
 * every field there changes how the turn RUNS, and an in-process caller can set
 * all of them. The fields below configure the OBSERVATION channel the wire
 * opens alongside the turn, which in-process has no analogue for: a local
 * caller holds the handle itself. Folding them into `SendInput` would put a
 * field on the primary session API that silently does nothing off the wire.
 */
export interface ClientSendInput<P = unknown> extends SendInput<P> {
  /**
   * Stream the progress signals of this turn's SUB-AGENTS, not just its own.
   *
   * A tool calling `ctx.progress(...)` emits a signal scoped to the session and
   * execution it runs in. The turn you started is one execution; a sub-agent it
   * spawns runs its own, so by default a sub-agent's progress is invisible to
   * you — which is exactly backwards for the case that needs it most, a long
   * fan-out whose only liveness is happening one level down.
   *
   * With `fanIn`, a signal joins your stream when its session's lineage reaches
   * this execution: the turn's own signals, its children's, its grandchildren's
   * — including work a descendant started from a later turn of its own. A
   * SIBLING execution's signals never do, on this session or any other, so two
   * concurrent turns on one session stay separate streams.
   *
   * ```ts
   * const turn = session.send({ messages, fanIn: true });
   * for await (const frame of client.transport.progress(token)) {
   *   // frames from the root turn AND from every sub-agent under it
   * }
   * ```
   *
   * Signals only — a child's execution EVENTS are still its own. Membership is
   * read from the live session registry, so a descendant whose ancestor has
   * been paged out is not reachable and its signals do not arrive.
   *
   * Defaults to `false`: fan-in is more than a caller asked for, and a UI built
   * against one turn's frames should not start seeing another's because a tool
   * learned to spawn.
   */
  readonly fanIn?: boolean;
}

/**
 * The hand-written CORE of the client session handle — the members that are NOT
 * derived from wire rows and NOT per-harness sub-handles. `send()` returns a
 * `ClientSessionExecutionHandle` (same shape as the server-side
 * `SessionExecutionHandle`: AsyncIterable + `.result` + `abort()`), so in-process
 * and remote calls have identical types.
 *
 * The full {@link SessionHandle} intersects this base with the per-harness
 * sub-handles ({@link SessionHandleExtensions}) AND the wire-derived namespace
 * surface ({@link SessionWireNamespaces}).
 */
export interface SessionHandleBase extends ResourceHandle, HandleSubscriptions {
  send<P = unknown>(input: ClientSendInput<P>): ClientSessionExecutionHandle;
  dispatch(tool: string, input: unknown): Promise<readonly ContentBlock[]>;
  /**
   * Cancel the session's current execution. `{ cascade: true }` widens the
   * scope to its live spawn subtree — the same `SessionAbortOptions` the
   * in-process harness takes, over the wire.
   */
  abort(reason?: string, opts?: SessionAbortOptions): Promise<void>;
  /**
   * The model this session is about to call, and what is known about it —
   * window, output cap, pricing, capabilities.
   *
   * Prefer this over `client.app(id).modelInfo(...)` for anything describing
   * the CURRENT conversation. The app knows its default; a session changes
   * model at runtime, and only the session knows what is actually bound. It
   * also answers before the first turn, where message provenance cannot.
   *
   * `null` when the session has no model bound — a legal state, not a failure.
   */
  modelInfo(): Promise<SessionModelInfoResult>;
  /**
   * Compile what a tick WOULD send, without sending it — for a debug surface
   * that shows a developer the live prompt.
   *
   * ```ts
   * const { tree, input } = await session.dryRun();
   * ```
   *
   * `tree` is the IR the components produced; `input` is what the model sees.
   * The provider-native request stays server-side — it is adapter-shaped and
   * not guaranteed JSON-clean, so ask the server that holds the adapter.
   *
   * Nothing is sent and no timeline entry is written, but this is NOT free:
   * the server renders the tree to answer, so `useData` fetches and any
   * lifecycle hook on the render path fires.
   *
   * The response carries the entire prompt — system instructions, retrieved
   * context, identity. Treat it as the most sensitive read on this handle.
   */
  dryRun(): Promise<{ readonly tree: unknown; readonly input: unknown }>;
  /** Rung 1 alone — the rendered IR. Needs no model on the server. */
  compile(): Promise<unknown>;
  /** Rung 2 alone — the canonical input the model sees. */
  project(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  /**
   * Rebind the session to a refreshed auth context. Used when a token
   * expires mid-session and the client refreshes without dropping the
   * session.
   *
   * Filled in by ADR 34.
   */
  rebind(auth: unknown): Promise<void>;
  close(): Promise<void>;
  /**
   * Events from this session AND its live spawn subtree — the
   * `{ kind: "session-tree" }` twin of {@link ResourceHandle.events}, which sees
   * this session alone.
   *
   * Reach for it to watch work that outlives a turn: a detached task or a
   * cross-turn sub-agent emits on ITS OWN session's channels, so a plain
   * `events()` subscription shows a client attached to the root nothing at all.
   *
   * ```ts
   * const stream = session.treeEvents({ name: { exact: "session:channel:tasks" } });
   * for await (const frame of stream) {
   *   // Which member emitted rides the envelope, as it always has.
   *   render(frame.envelope.scope.sessionId, frame.envelope.payload);
   * }
   * ```
   *
   * Members live when the subscription opens contribute their current channel
   * snapshot first (root's, then descendants'); a member spawned later simply
   * emits onto the live stream as it populates.
   */
  treeEvents(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream;

  // Elicitation (the `elicitations` property — an `ElicitationsHandle`, read via
  // `list()`/`subscribe()`, reply via `.respond(...)` / item verbs) is contributed
  // as a per-harness sub-handle by `@agentick/elicitation/client` via
  // {@link SessionHandleExtensions} (ADR 87) — client-core stays harness-agnostic.
}

/**
 * The wire-derived namespaces MERGED PER METHOD with the rich sub-handle that
 * claims the same namespace.
 *
 * The merge is per-METHOD, not per-namespace: a sub-handle owns the rows it
 * implements and the namespace's REMAINING rows stay reachable through the wire
 * (`session.timeline.compact(…)` sits beside the hand-written
 * `session.timeline.history(…)`). Omitting the whole namespace — the shape this
 * replaces — made every unmirrored row unreachable except through raw
 * `client.request`, which is how a shipped, gateway-served, e2e-tested
 * `timeline/compact` ended up with no way to call it.
 *
 * A handle method WINS over a same-named wire row, and that shadowing is
 * deliberate: `state.get(key)` / `skills.get(name)` / `prompts.get(name)` are
 * SYNC snapshot reads against the handle's local mirror, a different contract
 * from the async `state/get` / `skills/get` / `prompts/get` rows. The handle's
 * contract is the published one; the row stays shadowed. The runtime proxy
 * enforces the same precedence.
 *
 * `NonNullable` because an OPTIONAL slot (`readonly live?: SessionLive`) would
 * otherwise make `keyof` collapse to `never` and re-expose every row the handle
 * already owns.
 */
type MergedSessionNamespaces = {
  [NS in SessionWireNamespace]: NS extends keyof SessionHandleExtensions
    ? SessionHandleExtensions[NS] &
        Omit<WireNamespaceMethods<NS>, keyof NonNullable<SessionHandleExtensions[NS]>>
    : WireNamespaceMethods<NS>;
};

/**
 * Client-side session handle = **WIRE PROXY + VIEW FACTORY** (B2 slice 4):
 *
 *   - {@link SessionHandleBase} — the hand-written core (`send`, `dispatch`, …).
 *   - {@link SessionHandleExtensions} — per-harness rich sub-handles
 *     (`session.knobs`, `session.timeline`, …), contributed via ADR-87
 *     augmentation. A slot with no wire namespace of its own
 *     (`session.clientToolCalls`) rides through as-is.
 *   - {@link MergedSessionNamespaces} — every session-scoped wire namespace,
 *     each merged PER METHOD with the sub-handle that claims it (the sub-handle
 *     wins; the leftover rows fall through). Zero client code: declare the row +
 *     the gateway handler and the typed client method falls out.
 *
 * A `type` (not an `interface`) because it intersects a mapped type; augmentation
 * happens on `SessionHandleExtensions` / `WireMethods`, never on `SessionHandle`
 * directly, so nothing depends on it being an interface.
 */
export type SessionHandle = SessionHandleBase &
  Omit<SessionHandleExtensions, keyof SessionHandleBase | SessionWireNamespace> &
  Omit<MergedSessionNamespaces, keyof SessionHandleBase>;

/**
 * Identical shape to server-side `SessionExecutionHandle`. Re-exported
 * here under a client-specific name so adopters can disambiguate in
 * code that runs against both transports.
 */
export type ClientSessionExecutionHandle = SessionExecutionHandle;

export type { SendResult };
