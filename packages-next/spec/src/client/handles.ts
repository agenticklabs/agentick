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

export interface GatewayHandle {
  listApps(): Promise<GatewayListAppsResult>;
  getApp(id: string): Promise<GatewayListAppsResult["apps"][number]>;
  events(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream;
  app(id: string): AppHandle;
}

// ============================================================================
// AppHandle
// ============================================================================

export interface AppHandle extends ResourceHandle {
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
 * Client-side session handle. `send()` returns a `ClientSessionExecutionHandle`
 * — same shape as the server-side `SessionExecutionHandle` (AsyncIterable +
 * `.result` + `abort()`), guaranteeing in-process and remote calls have
 * identical types.
 */
export interface SessionHandle extends ResourceHandle {
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
