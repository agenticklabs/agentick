/**
 * In-process MessageInbox implementation.
 *
 * Address registry + per-messageId idempotency cache. Tell is
 * fire-and-forget with delivery ack (the handler runs concurrently);
 * ask awaits the handler's return value.
 *
 * Idempotency: same `messageId` arriving twice runs the handler exactly
 * once. We fork the handler into a Fiber the first time; subsequent
 * tell/ask calls reuse the same Fiber via `Fiber.join`. The cached ack
 * is returned for tell; the cached result for ask. TTL eviction
 * defaults to 10 minutes.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The MessageInbox
 */

import { Effect, Fiber } from "effect";
import type {
  InboxError,
  MessageAck,
  MessageEnvelope,
  MessageEnvelopeInput,
  MessageHandler,
  MessageHandlerError,
  MessageInboxFactory,
} from "@agentick/spec";
import type { AskOptions, MessageInbox, Unsubscribe } from "@agentick/spec";

/** Minimal parent-harness shape that `LocalInbox.createFactory` consumes. */
export interface LocalInboxFactoryParent {
  onClose(handler: () => void | Promise<void>): void;
}
import { ulid } from "./ulid.js";

/**
 * Promote a caller's {@link MessageEnvelopeInput} to a full
 * {@link MessageEnvelope}. Stamps `addressedTo`, `messageId` (if not
 * supplied), and `timestamp`.
 */
function stampEnvelope<T>(address: string, input: MessageEnvelopeInput<T>): MessageEnvelope<T> {
  return {
    addressedTo: address,
    type: input.type,
    messageId: input.messageId ?? ulid(),
    timestamp: Date.now(),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.parentOpId !== undefined ? { parentOpId: input.parentOpId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
}

interface IdempotencyEntry {
  readonly expiresAt: number;
  /**
   * Fiber running the handler. `Fiber.join` returns the same result on
   * every call — the handler runs exactly once.
   */
  readonly fiber: Fiber.RuntimeFiber<unknown, MessageHandlerError>;
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
   * Called when a tell-mode handler fails. Useful for surfacing errors to
   * telemetry without crashing the inbox. Default: swallow.
   */
  readonly onTellError?: (
    address: string,
    message: MessageEnvelope,
    error: MessageHandlerError | unknown,
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

  /**
   * Build a per-child factory for {@link LocalInbox}. Consumed by any
   * harness's `inbox` slot in the hierarchy. The factory constructs a
   * fresh inbox per call and auto-registers its `close()` on the
   * supplied parent's `onClose`.
   *
   * **Inbox does NOT compose with a parent inbox.** Inboxes are
   * addressable (callers `send` to a named address), not broadcast —
   * fan-in to a parent would misroute messages across tenants.
   * Isolation is the only meaningful semantic, and that's what this
   * factory produces.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  static createFactory<P extends LocalInboxFactoryParent>(
    configFn?: (parent: P) => LocalInboxOptions,
  ): MessageInboxFactory<P> {
    return (parent: P): MessageInbox => {
      const inbox = new LocalInbox(configFn?.(parent));
      parent.onClose(() => inbox.close());
      return inbox;
    };
  }

  register<T = unknown, R = unknown>(
    address: string,
    handler: MessageHandler<T, R>,
  ): Effect.Effect<Unsubscribe, InboxError, never> {
    return Effect.suspend((): Effect.Effect<Unsubscribe, InboxError, never> => {
      if (this.closed) {
        return Effect.fail({ _tag: "InboxClosed" });
      }
      if (this.handlers.has(address)) {
        return Effect.fail({
          _tag: "RoutingFailed",
          cause: new Error(`address already registered: ${address}`),
        });
      }
      this.handlers.set(address, handler as MessageHandler<unknown, unknown>);
      const unsub: Unsubscribe = () => {
        const current = this.handlers.get(address);
        if (current === (handler as unknown)) this.handlers.delete(address);
      };
      return Effect.succeed(unsub);
    });
  }

  send<T = unknown>(
    address: string,
    input: MessageEnvelopeInput<T>,
  ): Effect.Effect<MessageAck, InboxError, never> {
    return Effect.suspend((): Effect.Effect<MessageAck, InboxError, never> => {
      if (this.closed) {
        return Effect.fail({ _tag: "InboxClosed" });
      }

      const message = stampEnvelope(address, input);
      const cached = this.lookup(message.messageId);
      if (cached) return Effect.succeed(cached.ack);

      const handler = this.handlers.get(address);
      if (!handler) {
        return Effect.fail({ _tag: "AddressNotFound", address });
      }
      const ack: MessageAck = { messageId: message.messageId, receivedAt: Date.now() };
      const handlerEffect = handler(message as MessageEnvelope<unknown>);

      // Fork the handler so tell semantics deliver-and-return without
      // awaiting the handler. The fiber runs on the global runtime;
      // FiberRefs from the calling context propagate via the fork.
      const fiber = Effect.runFork(handlerEffect);
      // Tell-side: surface failures via onTellError once.
      Effect.runFork(
        Fiber.join(fiber).pipe(
          Effect.catchAll((cause) =>
            Effect.sync(() => {
              this.onTellError(address, message as MessageEnvelope, cause);
            }),
          ),
        ),
      );
      this.remember(message.messageId, ack, fiber);
      return Effect.succeed(ack);
    });
  }

  ask<T = unknown, R = unknown>(
    address: string,
    input: MessageEnvelopeInput<T>,
    options: AskOptions = {},
  ): Effect.Effect<R, InboxError | MessageHandlerError, never> {
    return Effect.suspend((): Effect.Effect<R, InboxError | MessageHandlerError, never> => {
      if (this.closed) {
        return Effect.fail<InboxError>({ _tag: "InboxClosed" });
      }

      const message = stampEnvelope(address, input);
      const cached = this.lookup(message.messageId);
      if (cached) {
        // Reuse the existing fiber — handler ran (or is running) once.
        return Fiber.join(cached.fiber) as Effect.Effect<R, MessageHandlerError, never>;
      }

      const handler = this.handlers.get(address);
      if (!handler) {
        return Effect.fail<InboxError>({ _tag: "AddressNotFound", address });
      }

      const timeoutMs = options.timeoutMs ?? 30_000;
      const ack: MessageAck = { messageId: message.messageId, receivedAt: Date.now() };

      const handlerEffect = handler(message as MessageEnvelope<unknown>) as Effect.Effect<
        R,
        MessageHandlerError,
        never
      >;
      const fiber = Effect.runFork(handlerEffect);
      this.remember(
        message.messageId,
        ack,
        fiber as Fiber.RuntimeFiber<unknown, MessageHandlerError>,
      );

      return (Fiber.join(fiber) as Effect.Effect<R, MessageHandlerError, never>).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: (): InboxError => ({ _tag: "AskTimeout", timeoutMs }),
        }),
      );
    });
  }

  /** Close inbox: pending iterators terminate, further calls fail. */
  close(): void {
    this.closed = true;
    this.handlers.clear();
    // Interrupt in-flight fibers so handlers don't outlive the inbox.
    for (const entry of this.cache.values()) {
      Effect.runFork(Fiber.interrupt(entry.fiber));
    }
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

  private remember(
    messageId: string,
    ack: MessageAck,
    fiber: Fiber.RuntimeFiber<unknown, MessageHandlerError>,
  ): void {
    if (this.cache.size >= this.maxEntries) {
      // Drop the oldest entry (Map preserves insertion order).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(messageId, {
      ack,
      fiber,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}
