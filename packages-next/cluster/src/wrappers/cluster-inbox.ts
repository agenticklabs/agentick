/**
 * `ClusterInbox` — wraps a local {@link MessageInbox} with cluster-aware
 * routing. The address-owner partition decides whether a `send` /
 * `ask` is dispatched locally or forwarded across the cluster wire.
 *
 * Routing:
 *   - `partitioning.shardKeyFor(address) → shardKey`
 *   - `partitioning.nodeFor(shardKey) → owner`
 *   - if `owner === currentNode` → `local.send` / `local.ask` (cheap)
 *   - else → `transport.send(owner, envelope)` (cross-node)
 *
 * Inbound delivery:
 *   - On construction, the wrapper subscribes to `transport.subscribeInbox({})`.
 *   - For every inbound envelope, the wrapper calls `local.send(addressedTo, env)`
 *     so the local handler registry picks it up exactly as if the message
 *     had arrived locally. Idempotency is preserved (the original
 *     `messageId` is carried through).
 *
 * Scope in Phase 3:
 *   - Cross-node `send` is fully wired.
 *   - Cross-node `ask` is NOT wired — it requires request/response
 *     correlation across the cluster. Calls to `ask` for a remote-owned
 *     address fail with `InboxError { _tag: "AskTimeout" }` after
 *     reporting via a Phase 3b pointer in the cause. Local `ask`
 *     delegates straight through.
 *   - `register` is local-only — registration state isn't gossiped
 *     across the cluster. Addresses MUST live on their partition-owner;
 *     adopters who put a handler on the wrong node will simply not
 *     receive cross-node deliveries (the transport's `subscribeInbox`
 *     receives them but `local.send` returns `AddressNotFound`).
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

import { Effect } from "effect";
import type {
  AskOptions,
  MessageAck,
  MessageEnvelope,
  MessageEnvelopeInput,
  MessageHandler,
  MessageInbox,
  Unsubscribe,
} from "@agentick/spec-next";
import type { InboxError, MessageHandlerError } from "@agentick/spec-next";

import type { ClusterPartitioning } from "../partitioning.js";
import type { ClusterTransport } from "../transport.js";
import type { NodeId } from "../types.js";

export interface ClusterInboxOptions {
  readonly local: MessageInbox;
  readonly transport: ClusterTransport;
  readonly partitioning: ClusterPartitioning;
  readonly currentNode: NodeId;
}

export class ClusterInbox implements MessageInbox {
  private readonly local: MessageInbox;
  private readonly transport: ClusterTransport;
  private readonly partitioning: ClusterPartitioning;
  private readonly currentNode: NodeId;

  private inboundUnsubscribe: (() => Promise<void>) | null = null;
  private closed = false;

  constructor(opts: ClusterInboxOptions) {
    this.local = opts.local;
    this.transport = opts.transport;
    this.partitioning = opts.partitioning;
    this.currentNode = opts.currentNode;

    // Inbound dispatch: every cross-node message routed to this node's
    // address space arrives via the transport callback and gets handed
    // to the local inbox, where the registered handler picks it up.
    this.inboundUnsubscribe = this.transport.subscribeInbox({}, (env) => {
      this.dispatchInbound(env);
    });
  }

  // ============================================================================
  // MessageInbox
  // ============================================================================

  register<T = unknown, R = unknown>(
    address: string,
    handler: MessageHandler<T, R>,
  ): Effect.Effect<Unsubscribe, InboxError, never> {
    return this.local.register(address, handler);
  }

  send<T = unknown>(
    address: string,
    input: MessageEnvelopeInput<T>,
  ): Effect.Effect<MessageAck, InboxError, never> {
    return Effect.suspend((): Effect.Effect<MessageAck, InboxError, never> => {
      if (this.closed) return Effect.fail({ _tag: "InboxClosed" });
      return Effect.flatMap(
        Effect.promise(() => this.resolveOwner(address)),
        (owner) => {
          if (owner === this.currentNode) {
            return this.local.send(address, input);
          }
          return this.sendRemote(owner, address, input);
        },
      );
    });
  }

  ask<T = unknown, R = unknown>(
    address: string,
    input: MessageEnvelopeInput<T>,
    options?: AskOptions,
  ): Effect.Effect<R, InboxError | MessageHandlerError, never> {
    return Effect.suspend((): Effect.Effect<R, InboxError | MessageHandlerError, never> => {
      if (this.closed) return Effect.fail<InboxError>({ _tag: "InboxClosed" });
      return Effect.flatMap(
        Effect.promise(() => this.resolveOwner(address)),
        (owner) => {
          if (owner === this.currentNode) {
            return this.local.ask<T, R>(address, input, options);
          }
          // Phase 3b — request/response correlation registry not yet
          // wired. Adopters needing remote ask should keep ask-shaped
          // calls node-local until the registry lands.
          return Effect.fail<InboxError>({
            _tag: "RoutingFailed",
            cause: new Error(
              `cluster-next Phase 3: ask() across nodes is not yet supported ` +
                `(target node ${owner} != current ${this.currentNode}). ` +
                `Use send() for fire-and-forget, or keep ask() partitions node-local. ` +
                `Phase 3b will land remote ask via the RequestResponseRegistry pattern.`,
            ),
          });
        },
      );
    });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const unsub = this.inboundUnsubscribe;
    this.inboundUnsubscribe = null;
    if (unsub) await unsub();
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private async resolveOwner(address: string): Promise<NodeId> {
    const shardKey = this.partitioning.shardKeyFor(address);
    return this.partitioning.nodeFor(shardKey);
  }

  private sendRemote<T>(
    owner: NodeId,
    address: string,
    input: MessageEnvelopeInput<T>,
  ): Effect.Effect<MessageAck, InboxError, never> {
    const env: MessageEnvelope<T> = stampEnvelope(address, input, this.currentNode);
    return Effect.tryPromise<MessageAck, InboxError>({
      try: async () => {
        await this.transport.send(owner, env);
        return { messageId: env.messageId, receivedAt: Date.now() };
      },
      catch: (cause): InboxError => ({
        _tag: "RoutingFailed",
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      }),
    });
  }

  /**
   * Run an inbound cross-node envelope through the LOCAL inbox so the
   * registered handler at `addressedTo` picks it up. Failures (no
   * handler registered, address closed) surface via the local inbox's
   * onTellError pathway — the transport call itself doesn't fail.
   */
  private dispatchInbound(env: MessageEnvelope): void {
    if (this.closed) return;
    // The original envelope's messageId is preserved (idempotency);
    // local.send re-stamps `addressedTo` (no-op since we pass the same
    // address) and `timestamp` (becomes receive-time, intentional).
    const input: MessageEnvelopeInput = {
      type: env.type,
      messageId: env.messageId,
      ...(env.from !== undefined ? { from: env.from } : {}),
      ...(env.parentOpId !== undefined ? { parentOpId: env.parentOpId } : {}),
      ...(env.correlationId !== undefined ? { correlationId: env.correlationId } : {}),
      ...(env.payload !== undefined ? { payload: env.payload } : {}),
    };
    Effect.runFork(
      this.local.send(env.addressedTo, input).pipe(
        Effect.catchAll(
          () =>
            // Swallow — no handler registered on this node is a
            // valid outcome (route table convergence lag, etc).
            // The local inbox emits onTellError diagnostics when
            // a handler IS present but throws.
            Effect.void,
        ),
      ),
    );
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Stamp a {@link MessageEnvelopeInput} into a full {@link MessageEnvelope}
 * for cross-node transmission. Mirrors LocalInbox's internal stamping
 * but adds `from` defaulting to the current node if not supplied so
 * receivers can identify the origin.
 */
function stampEnvelope<T>(
  address: string,
  input: MessageEnvelopeInput<T>,
  currentNode: NodeId,
): MessageEnvelope<T> {
  return {
    addressedTo: address,
    type: input.type,
    messageId: input.messageId ?? quickId(),
    timestamp: Date.now(),
    from: input.from ?? `node:${currentNode}`,
    ...(input.parentOpId !== undefined ? { parentOpId: input.parentOpId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
}

/**
 * Local id generator — see cluster-event-bus.ts for the same rationale.
 * Not a true ULID; sufficient for transport-level uniqueness when the
 * caller hasn't supplied a messageId.
 */
function quickId(): string {
  return `msg-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}
