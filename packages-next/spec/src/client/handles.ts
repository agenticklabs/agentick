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
import type { CreateSessionInput, SessionEntry, SessionFilter } from "../protocol/app-harness.js";
import type { SendInput, SendResult, SessionExecutionHandle } from "../protocol/session-harness.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type {
  GatewayListAppsResult,
  AppCreateSessionResult,
  AppRunOnceResult,
} from "../wire/params.js";
import type { ClientElicitationStream } from "./elicitation.js";
import type { SubscriptionStream } from "./transport.js";
import type { Unsubscribe } from "../protocol/inbox.js";
import type { OnSignalOptions, ReceivedLog, ReceivedProgress } from "./signals.js";
import type { ChannelView, ChannelViewConfig } from "./channel.js";

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
  events(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream;
  app(id: string): AppHandle;
}

// ============================================================================
// AppHandle
// ============================================================================

export interface AppHandle extends ResourceHandle, HandleSubscriptions {
  createSession<P = unknown>(input?: CreateSessionInput<P>): Promise<AppCreateSessionResult>;
  getSession(sessionId: string): Promise<SessionEntry>;
  listSessions(filter?: SessionFilter): Promise<readonly SessionEntry[]>;
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
 * // in @agentick/tasks-next/client:
 * declare module "@agentick/spec-next" {
 *   interface SessionHandleExtensions { readonly tasks: ChannelView<TaskStatusMap>; }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionHandleExtensions {}

/**
 * Client-side session handle. `send()` returns a `ClientSessionExecutionHandle`
 * — same shape as the server-side `SessionExecutionHandle` (AsyncIterable +
 * `.result` + `abort()`), guaranteeing in-process and remote calls have
 * identical types. Carries the generic subscription surface ({@link
 * HandleSubscriptions}) plus per-harness sub-handles ({@link SessionHandleExtensions}).
 */
export interface SessionHandle
  extends ResourceHandle, HandleSubscriptions, SessionHandleExtensions {
  send<P = unknown>(input: SendInput<P>): ClientSessionExecutionHandle;
  dispatch(tool: string, input: unknown): Promise<readonly ContentBlock[]>;
  abort(reason?: string): Promise<void>;
  queue(messages: SendInput["messages"]): Promise<{ readonly queuedIds: readonly string[] }>;
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
   * AsyncIterable of inbound elicitation requests for this session.
   * Built on top of the existing event subscription — filters bus
   * envelopes on `session:channel:elicitation` and yields parsed
   * {@link ClientElicitationHandle} values with typed `.accept` /
   * `.decline` / `.cancel` convenience methods.
   *
   * The iterator stays live until `close()` is called or the
   * underlying subscription is dropped. Multiple concurrent iterators
   * are supported — each gets an independent subscription with its
   * own cursor.
   */
  elicitations(opts?: { fromCursor?: Cursor }): ClientElicitationStream;

  /**
   * Reply to a pending elicitation. Routes through the
   * `session/respond_to_elicitation` wire method to the server's
   * `bridges.elicitation.respond({correlationId, outcome, value?,
   * reason?})`. Idempotent — unknown / already-resolved correlationIds
   * are silent no-ops (first-write-wins).
   *
   * Prefer the typed `.accept` / `.decline` / `.cancel` methods on
   * the {@link ClientElicitationHandle} when iterating the
   * `elicitations()` stream — they thread `correlationId`
   * automatically.
   */
  respondToElicitation(input: {
    readonly correlationId: string;
    readonly outcome: "accepted" | "declined" | "cancelled";
    readonly value?: unknown;
    readonly reason?: string;
  }): Promise<void>;
}

/**
 * Identical shape to server-side `SessionExecutionHandle`. Re-exported
 * here under a client-specific name so adopters can disambiguate in
 * code that runs against both transports.
 */
export type ClientSessionExecutionHandle = SessionExecutionHandle;

export type { SendResult };
