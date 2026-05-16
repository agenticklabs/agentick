/**
 * MessageInbox protocol.
 *
 * Addressable inbound message channel. The actor's mailbox. Wire-safe
 * by construction — same handler signature local or remote.
 *
 * Implementations:
 *   - LocalInbox    (in-process registry; Phase 2)
 *   - ClusterInbox  (cluster routing; Phase 7)
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The MessageInbox
 * @see docs/proposals/v2/blueprint/01-harness-principle.md §② Inbox
 */

import type { Effect } from "effect";
import type {
  MessageAck,
  MessageEnvelope,
  MessageHandler,
} from "../data/inbox.js";
import type { InboxError, MessageHandlerError } from "../data/errors.js";

/**
 * Disposable subscription returned by `register()`.
 */
export type Unsubscribe = () => void;

/**
 * Options for `ask()`.
 */
export interface AskOptions {
  /** Timeout for the response. Default: 30_000ms. */
  readonly timeoutMs?: number;
}

/**
 * The inbox protocol.
 *
 * Addressing convention: `{surface}:{scopeId}`.
 *   `loop:execution-abc-123`
 *   `session:user-42`
 *   `supervisor:main`
 *
 * Errors flow through the Effect `E` channel as tagged-union values.
 * Routing-side failures use `InboxError`; handler-side failures use
 * `MessageHandlerError` (surfaced via `ask`).
 */
export interface MessageInbox {
  /**
   * Register a handler for an address.
   *
   * Returns an `Unsubscribe` function that, when invoked, removes
   * the registration. Multiple registrations at the same address
   * MUST fail with `InboxError { _tag: "RoutingFailed" }`;
   * each address has exactly one owner.
   */
  register<T = unknown, R = unknown>(
    address: string,
    handler: MessageHandler<T, R>,
  ): Effect.Effect<Unsubscribe, InboxError, never>;

  /**
   * Tell: send a message to an address, fire-and-forget with ack.
   *
   * Succeeds with `MessageAck` when the recipient has accepted the
   * message (it has been queued or dispatched). Does NOT wait for
   * handler completion — use `ask()` for that.
   *
   * Idempotent on `message.messageId`. Same id twice → first call
   * runs the handler; subsequent calls return the cached ack.
   */
  send<T = unknown>(
    address: string,
    message: MessageEnvelope<T>,
  ): Effect.Effect<MessageAck, InboxError, never>;

  /**
   * Ask: send a message and await the typed response.
   *
   * RPC-shaped. Has a timeout because remote handlers may be
   * unreachable. Use sparingly — most messages should be tell.
   *
   * Idempotent on `message.messageId`. Same id twice → first call
   * runs the handler; subsequent calls return the cached response.
   */
  ask<T = unknown, R = unknown>(
    address: string,
    message: MessageEnvelope<T>,
    options?: AskOptions,
  ): Effect.Effect<R, InboxError | MessageHandlerError, never>;
}
