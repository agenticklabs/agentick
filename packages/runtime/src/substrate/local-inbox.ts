/**
 * In-process MessageInbox implementation.
 *
 * Address registry + per-messageId idempotency cache. Tell is
 * fire-and-forget with delivery ack (the handler runs concurrently and
 * exceptions surface to an `onHandlerError` callback when supplied);
 * ask awaits the handler's return value.
 *
 * Idempotency: same `messageId` arriving twice runs the handler exactly
 * once. The cached result is returned for ask; the cached ack for tell.
 * TTL eviction defaults to 10 minutes.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The MessageInbox
 */

import type {
  InboxError,
  MessageAck,
  MessageEnvelope,
  MessageHandler,
  MessageHandlerError,
} from "@agentick/spec";
import type { AskOptions, MessageInbox, Unsubscribe } from "@agentick/spec";

interface IdempotencyEntry {
  readonly expiresAt: number;
  /** Resolves with the handler's return value (for ask) once known. */
  readonly result: Promise<unknown>;
  /** Cached ack. */
  readonly ack: MessageAck;
}

export interface LocalInboxOptions {
  /**
   * TTL for idempotency cache entries in milliseconds. Default: 600_000 (10 min).
   */
  readonly idempotencyTtlMs?: number;
  /**
   * Maximum entries kept in the idempotency cache. LRU-evicted past
   * this point. Default: 10_000.
   */
  readonly idempotencyMaxEntries?: number;
  /**
   * Called when a tell-mode handler throws asynchronously. Useful for
   * surfacing errors to telemetry without crashing the inbox. Default:
   * swallow.
   */
  readonly onTellError?: (
    address: string,
    message: MessageEnvelope,
    error: unknown,
  ) => void;
}

export class LocalInbox implements MessageInbox {
  private handlers = new Map<string, MessageHandler<unknown, unknown>>();
  private cache = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly onTellError: NonNullable<LocalInboxOptions["onTellError"]>;
  private closed = false;

  constructor(options: LocalInboxOptions = {}) {
    this.ttlMs = options.idempotencyTtlMs ?? 600_000;
    this.maxEntries = options.idempotencyMaxEntries ?? 10_000;
    this.onTellError = options.onTellError ?? (() => {});
  }

  async register<T = unknown, R = unknown>(
    address: string,
    handler: MessageHandler<T, R>,
  ): Promise<Unsubscribe> {
    if (this.closed) {
      throw inboxError({ _tag: "InboxClosed" });
    }
    if (this.handlers.has(address)) {
      throw inboxError({
        _tag: "RoutingFailed",
        cause: new Error(`address already registered: ${address}`),
      });
    }
    this.handlers.set(address, handler as MessageHandler<unknown, unknown>);
    return () => {
      const current = this.handlers.get(address);
      if (current === (handler as unknown)) this.handlers.delete(address);
    };
  }

  async send<T = unknown>(
    address: string,
    message: MessageEnvelope<T>,
  ): Promise<MessageAck> {
    if (this.closed) throw inboxError({ _tag: "InboxClosed" });

    const cached = this.lookup(message.messageId);
    if (cached) return cached.ack;

    const handler = this.handlers.get(address);
    if (!handler) {
      throw inboxError({ _tag: "AddressNotFound", address });
    }
    const ack: MessageAck = { messageId: message.messageId, receivedAt: Date.now() };
    // Run handler concurrently — tell semantics.
    const result = Promise.resolve()
      .then(() => handler(message as MessageEnvelope<unknown>))
      .catch((err) => {
        this.onTellError(address, message as MessageEnvelope, err);
        throw err;
      });
    this.remember(message.messageId, ack, result);
    return ack;
  }

  async ask<T = unknown, R = unknown>(
    address: string,
    message: MessageEnvelope<T>,
    options: AskOptions = {},
  ): Promise<R> {
    if (this.closed) throw inboxError({ _tag: "InboxClosed" });

    const cached = this.lookup(message.messageId);
    if (cached) return cached.result as Promise<R>;

    const handler = this.handlers.get(address);
    if (!handler) {
      throw inboxError({ _tag: "AddressNotFound", address });
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    const ack: MessageAck = { messageId: message.messageId, receivedAt: Date.now() };

    const handlerCall = Promise.resolve().then(() => handler(message as MessageEnvelope<unknown>));
    this.remember(message.messageId, ack, handlerCall);

    return (await Promise.race([
      handlerCall.catch((cause): never => {
        // Wrap handler errors per spec; routing errors stay separate.
        throw handlerError({ _tag: "HandlerError", cause });
      }),
      delayReject<R>(timeoutMs, options.signal, () =>
        inboxError({ _tag: "AskTimeout", timeoutMs }),
      ),
    ])) as R;
  }

  /** Close inbox: pending iterators terminate, further calls fail. */
  close(): void {
    this.closed = true;
    this.handlers.clear();
    this.cache.clear();
  }

  /** Diagnostic. */
  registeredAddresses(): readonly string[] {
    return [...this.handlers.keys()];
  }

  // ────────── helpers ──────────

  private lookup(messageId: string): IdempotencyEntry | undefined {
    const entry = this.cache.get(messageId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(messageId);
      return undefined;
    }
    return entry;
  }

  private remember(messageId: string, ack: MessageAck, result: Promise<unknown>): void {
    if (this.cache.size >= this.maxEntries) {
      // Drop the oldest entry (Map preserves insertion order).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(messageId, {
      ack,
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

function inboxError(err: InboxError): Error & InboxError {
  const e = new Error(err._tag) as Error & InboxError;
  Object.assign(e, err);
  e.name = "InboxError";
  return e;
}

function handlerError(err: MessageHandlerError): Error & MessageHandlerError {
  const e = new Error(err._tag) as Error & MessageHandlerError;
  Object.assign(e, err);
  e.name = "MessageHandlerError";
  return e;
}

function delayReject<T>(
  ms: number,
  signal: AbortSignal | undefined,
  buildError: () => Error,
): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const timer = setTimeout(() => reject(buildError()), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(buildError());
      },
      { once: true },
    );
  });
}
