/**
 * `ClusterInbox` — wraps a local {@link MessageInbox} with cluster-aware
 * routing. The address-owner partition decides whether a `send` /
 * `ask` is dispatched locally or forwarded across the cluster wire.
 *
 * Routing:
 *   - `partitioning.shardKeyFor(address) → shardKey`
 *   - `partitioning.nodeFor(shardKey) → owner`
 *   - if `owner === currentNode` → `local.send` / `local.ask` (cheap)
 *   - else → cross-node via {@link ClusterTransport.send}
 *
 * Cross-node `send` (tell-style):
 *   - The wrapper stamps a {@link MessageEnvelope}, forwards over the
 *     transport, and returns a synthetic `MessageAck` once the
 *     transport accepts the envelope. Adopter `type` / `payload` /
 *     `correlationId` pass through unchanged.
 *
 * Cross-node `ask` (request/response):
 *   - The wrapper wraps the adopter's envelope inside a
 *     {@link CLUSTER_ASK_TYPE} envelope addressed at the partition
 *     owner. The owner's wrapper unwraps, runs `local.ask` against
 *     the registered handler, then ships the discriminated outcome
 *     back via a {@link CLUSTER_ASK_RESPONSE_TYPE} envelope addressed
 *     at `@cluster/asks:<asker-node>`. The asker's wrapper looks up
 *     the pending correlationId, resolves the `Deferred`, and the
 *     `ask` Effect completes with the original {@link MessageHandlerError}
 *     shape preserved (failure round-trips structurally, not stringly).
 *
 * Inbound dispatch (`transport.subscribeInbox({})` callback):
 *   - `@cluster/ask`           → unwrap, run local.ask, send response back
 *   - `@cluster/ask-response`  → resolve pending Deferred by correlationId
 *   - everything else (adopter tells / forwarded sends) → `local.send`
 *     so the registered handler picks it up exactly as if it had
 *     arrived locally. Idempotency is preserved (the original
 *     `messageId` is carried through).
 *
 * Diagnostics emitted on the LOCAL bus (`surface: "cluster"`):
 *   - `cluster:transport:send:failed`         transport.send rejected
 *   - `cluster:routing:address-not-found`     inbound dispatched to no handler
 *   - `cluster:ask:dispatched`                remote ask forwarded
 *   - `cluster:ask:resolved`                  remote ask completed
 *   - `cluster:ask:timeout`                   remote ask exceeded timeoutMs
 *   - `cluster:ask:response-orphaned`         response arrived past pending entry
 *
 * Scope notes:
 *   - `register` is local-only — registration state isn't gossiped
 *     across the cluster. Addresses MUST live on their partition-owner;
 *     adopters who put a handler on the wrong node will simply not
 *     receive cross-node deliveries (the transport's `subscribeInbox`
 *     receives them, `local.send` returns `AddressNotFound`, the
 *     wrapper emits `cluster:routing:address-not-found`).
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

import { Cause, Effect } from "effect";
import type {
  AskOptions,
  EventBus,
  InboxError,
  MessageAck,
  MessageEnvelope,
  MessageEnvelopeInput,
  MessageHandler,
  MessageHandlerError,
  MessageInbox,
  Unsubscribe,
} from "@agentick/spec-next";
import { ulid } from "@agentick/utils-next";

import type { ClusterPartitioning } from "../partitioning.js";
import type { ClusterTransport } from "../transport.js";
import type { NodeId } from "../types.js";
import { DiagnosticEmitter, makeDiagnostics } from "./diagnostics.js";
import {
  CLUSTER_ASK_RESPONSE_TYPE,
  CLUSTER_ASK_TYPE,
  clusterReplyAddress,
  isClusterAskRequest,
  isClusterAskResponse,
  type ClusterAskRequestPayload,
  type ClusterAskResponsePayload,
} from "./internal-wire.js";

export interface ClusterInboxOptions {
  readonly local: MessageInbox;
  readonly transport: ClusterTransport;
  readonly partitioning: ClusterPartitioning;
  readonly currentNode: NodeId;
  /**
   * Local bus used purely for diagnostic emission. The wrappers append
   * `surface: "cluster"` events here so adopters subscribing to the
   * local bus see distributed behavior. Must be the LOCAL bus, not
   * the cluster-wrapped one — emitting a diagnostic about a broadcast
   * failure must not itself trigger another broadcast.
   */
  readonly localBus: EventBus;
}

/**
 * Internal pending-ask entry. Held in the wrapper's correlationId map
 * until the response envelope arrives or the timeout fires.
 */
interface PendingAsk {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: InboxError | MessageHandlerError) => void;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
}

export class ClusterInbox implements MessageInbox {
  private readonly local: MessageInbox;
  private readonly transport: ClusterTransport;
  private readonly partitioning: ClusterPartitioning;
  private readonly currentNode: NodeId;
  private readonly diag: DiagnosticEmitter;

  /**
   * Correlation registry for outbound asks awaiting a response from
   * a remote node. Cleared on response arrival or timeout.
   */
  private readonly pendingAsks = new Map<string, PendingAsk>();

  private inboundUnsubscribe: (() => Promise<void>) | null = null;
  private closed = false;

  constructor(opts: ClusterInboxOptions) {
    this.local = opts.local;
    this.transport = opts.transport;
    this.partitioning = opts.partitioning;
    this.currentNode = opts.currentNode;
    this.diag = makeDiagnostics({ localBus: opts.localBus, currentNode: opts.currentNode });

    // Inbound dispatch: every cross-node message routed to this node's
    // address space (whether an adopter tell, a cluster-internal ask
    // request, or a cluster-internal ask response) arrives here.
    this.inboundUnsubscribe = this.transport.subscribeInbox({}, (env) => {
      this.dispatchInbound(env);
    });

    this.diag.emit("cluster:wrap:installed", { kind: "inbox" });
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
        (owner): Effect.Effect<R, InboxError | MessageHandlerError, never> => {
          if (owner === this.currentNode) {
            return this.local.ask<T, R>(address, input, options);
          }
          return this.askRemote<T, R>(owner, address, input, options);
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
    this.diag.emit("cluster:wrap:disposed", { kind: "inbox" });

    // Reject every still-pending ask so callers' Effects don't hang
    // past close. The asker sees a clean `InboxClosed` outcome.
    for (const [, pending] of this.pendingAsks) {
      clearTimeout(pending.timeoutHandle);
      pending.reject({ _tag: "InboxClosed" });
    }
    this.pendingAsks.clear();

    const unsub = this.inboundUnsubscribe;
    this.inboundUnsubscribe = null;
    if (unsub) await unsub();
  }

  // ============================================================================
  // Internals — outbound
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
      catch: (cause): InboxError => {
        this.diag.emit("cluster:transport:send:failed", {
          target: owner,
          address,
          messageId: env.messageId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        return {
          _tag: "RoutingFailed",
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        };
      },
    });
  }

  /**
   * Cross-node ask: wrap the asker's envelope in `@cluster/ask`,
   * register a pending correlationId, ship via transport. The
   * response (or timeout) resolves the returned Effect.
   */
  private askRemote<T, R>(
    owner: NodeId,
    address: string,
    input: MessageEnvelopeInput<T>,
    options?: AskOptions,
  ): Effect.Effect<R, InboxError | MessageHandlerError, never> {
    const correlationId = ulid();
    const timeoutMs = options?.timeoutMs ?? 30_000;

    // Wrap the adopter's envelope as a cluster-internal ask request.
    const askPayload: ClusterAskRequestPayload<T> = {
      innerType: input.type,
      ...(input.payload !== undefined ? { innerPayload: input.payload } : {}),
      ...(input.from !== undefined ? { innerFrom: input.from } : {}),
      ...(input.parentOpId !== undefined ? { innerParentOpId: input.parentOpId } : {}),
      ...(input.correlationId !== undefined ? { innerCorrelationId: input.correlationId } : {}),
      timeoutMs,
    };
    const env: MessageEnvelope<ClusterAskRequestPayload<T>> = {
      addressedTo: address,
      type: CLUSTER_ASK_TYPE,
      messageId: input.messageId ?? ulid(),
      timestamp: Date.now(),
      from: clusterReplyAddress(this.currentNode),
      correlationId,
      payload: askPayload,
    };

    return Effect.async<R, InboxError | MessageHandlerError, never>((resume) => {
      const timeoutHandle = setTimeout(() => {
        if (!this.pendingAsks.delete(correlationId)) return;
        this.diag.emit("cluster:ask:timeout", {
          target: owner,
          address,
          correlationId,
          timeoutMs,
        });
        resume(Effect.fail<InboxError>({ _tag: "AskTimeout", timeoutMs }));
      }, timeoutMs);

      this.pendingAsks.set(correlationId, {
        resolve: (value) => resume(Effect.succeed(value as R)),
        reject: (error) => resume(Effect.fail(error)),
        timeoutHandle,
      });

      // Fire the wire send. If the transport rejects, we never get a
      // response — clean up the pending entry + timer immediately.
      this.transport.send(owner, env as MessageEnvelope).catch((cause) => {
        const pending = this.pendingAsks.get(correlationId);
        if (!pending) return; // already resolved/timed-out
        this.pendingAsks.delete(correlationId);
        clearTimeout(pending.timeoutHandle);
        this.diag.emit("cluster:transport:send:failed", {
          target: owner,
          address,
          messageId: env.messageId,
          correlationId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        pending.reject({
          _tag: "RoutingFailed",
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        });
      });

      this.diag.emit("cluster:ask:dispatched", {
        target: owner,
        address,
        correlationId,
        timeoutMs,
      });
    });
  }

  // ============================================================================
  // Internals — inbound
  // ============================================================================

  /**
   * Dispatch an inbound envelope. Three branches:
   *   - `@cluster/ask`            request → run local.ask, send response back
   *   - `@cluster/ask-response`   resolve pending correlationId
   *   - everything else           regular tell → local.send
   */
  private dispatchInbound(env: MessageEnvelope): void {
    if (this.closed) return;

    if (isClusterAskRequest(env)) {
      this.handleInboundAskRequest(env as MessageEnvelope<ClusterAskRequestPayload>);
      return;
    }

    if (isClusterAskResponse(env)) {
      this.handleInboundAskResponse(env as MessageEnvelope<ClusterAskResponsePayload>);
      return;
    }

    // Adopter tell — route to local handler.
    this.dispatchAdopterTell(env);
  }

  /**
   * Server side of a cross-node ask: run the asker's request against
   * the locally-registered handler, then ship the discriminated
   * outcome back. Failures of the handler (typed `MessageHandlerError`)
   * survive the round-trip; runtime defects flatten to the same.
   */
  private handleInboundAskRequest(env: MessageEnvelope<ClusterAskRequestPayload>): void {
    const askPayload = env.payload;
    if (!askPayload || !env.from || !env.correlationId) {
      this.diag.emit("cluster:ask:malformed-request", {
        messageId: env.messageId,
        address: env.addressedTo,
      });
      return;
    }

    const innerInput: MessageEnvelopeInput = {
      type: askPayload.innerType,
      ...(askPayload.innerPayload !== undefined ? { payload: askPayload.innerPayload } : {}),
      ...(askPayload.innerFrom !== undefined ? { from: askPayload.innerFrom } : {}),
      ...(askPayload.innerParentOpId !== undefined
        ? { parentOpId: askPayload.innerParentOpId }
        : {}),
      ...(askPayload.innerCorrelationId !== undefined
        ? { correlationId: askPayload.innerCorrelationId }
        : {}),
    };

    // Mirror the asker's timeout so the receiver doesn't wait
    // indefinitely when the asker has already given up.
    const askOptions: AskOptions | undefined =
      askPayload.timeoutMs !== undefined ? { timeoutMs: askPayload.timeoutMs } : undefined;

    const program = this.local.ask(env.addressedTo, innerInput, askOptions).pipe(
      Effect.matchCauseEffect({
        onSuccess: (value): Effect.Effect<void, never, never> =>
          this.shipAskResponse(env, { _tag: "success", value }),
        onFailure: (cause): Effect.Effect<void, never, never> => {
          const failure = causeToAskFailure(cause);
          return this.shipAskResponse(env, failure);
        },
      }),
    );

    Effect.runFork(program);
  }

  /**
   * Asker side: a response envelope arrived. Look up its
   * correlationId, clear the timeout, and resolve/reject the pending
   * Effect. Orphaned responses (no pending entry — timeout already
   * fired, or response from an unknown correlationId) emit a
   * diagnostic and are dropped.
   */
  private handleInboundAskResponse(env: MessageEnvelope<ClusterAskResponsePayload>): void {
    if (!env.correlationId) {
      this.diag.emit("cluster:ask:response-orphaned", {
        messageId: env.messageId,
        reason: "missing-correlation-id",
      });
      return;
    }
    const pending = this.pendingAsks.get(env.correlationId);
    if (!pending) {
      this.diag.emit("cluster:ask:response-orphaned", {
        messageId: env.messageId,
        correlationId: env.correlationId,
      });
      return;
    }
    this.pendingAsks.delete(env.correlationId);
    clearTimeout(pending.timeoutHandle);

    const payload = env.payload;
    if (!payload) {
      pending.reject({
        _tag: "RoutingFailed",
        cause: new Error("cluster ask-response had no payload"),
      });
      return;
    }
    this.diag.emit("cluster:ask:resolved", {
      correlationId: env.correlationId,
      outcome: payload._tag,
    });
    if (payload._tag === "success") {
      pending.resolve(payload.value);
    } else if (payload._tag === "fail") {
      pending.reject(payload.error);
    } else {
      // interrupt → surface as InboxClosed-style routing failure so
      // adopter sees a non-success outcome without inventing a new
      // tag in the spec.
      pending.reject({
        _tag: "RoutingFailed",
        cause: new Error("remote handler was interrupted"),
      });
    }
  }

  /**
   * Adopter-tell inbound dispatch. Pass through to local.send so the
   * registered handler picks it up; loudly diagnose `AddressNotFound`
   * (route table convergence lag or misconfiguration); silently
   * swallow `InboxClosed` (expected during teardown).
   */
  private dispatchAdopterTell(env: MessageEnvelope): void {
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
        Effect.catchAll((error: InboxError) =>
          Effect.sync(() => {
            if (error._tag === "AddressNotFound") {
              this.diag.emit("cluster:routing:address-not-found", {
                address: env.addressedTo,
                messageId: env.messageId,
                from: env.from,
              });
            }
            // InboxClosed during teardown is expected — silent.
            // RoutingFailed / other tags fall through silently as
            // well; the LOCAL inbox's onTellError pathway already
            // surfaces handler-side problems.
          }),
        ),
      ),
    );
  }

  /**
   * Build a `@cluster/ask-response` envelope and ship it back to the
   * asker via transport.send. Transport failures emit a diagnostic
   * but don't propagate — there's no upstream caller awaiting the
   * shipResponse outcome.
   */
  private shipAskResponse(
    request: MessageEnvelope<ClusterAskRequestPayload>,
    payload: ClusterAskResponsePayload,
  ): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const askerReplyAddress = request.from ?? clusterReplyAddress("unknown");
      const askerNode = extractAskerNode(askerReplyAddress);
      if (!askerNode || !request.correlationId) {
        this.diag.emit("cluster:ask:malformed-request", {
          messageId: request.messageId,
          reason: "missing-from-or-correlation",
        });
        return;
      }
      const response: MessageEnvelope<ClusterAskResponsePayload> = {
        addressedTo: askerReplyAddress,
        type: CLUSTER_ASK_RESPONSE_TYPE,
        messageId: ulid(),
        timestamp: Date.now(),
        correlationId: request.correlationId,
        from: clusterReplyAddress(this.currentNode),
        payload,
      };
      this.transport.send(askerNode, response as MessageEnvelope).catch((cause) => {
        this.diag.emit("cluster:transport:send:failed", {
          target: askerNode,
          address: askerReplyAddress,
          messageId: response.messageId,
          correlationId: request.correlationId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
  }
}

// ----------------------------------------------------------------------------
// Helpers — envelope stamping + cause mapping
// ----------------------------------------------------------------------------

/**
 * Stamp a {@link MessageEnvelopeInput} into a full {@link MessageEnvelope}
 * for cross-node transmission. Mirrors LocalInbox's internal stamping
 * but defaults `from` to the current node so receivers can identify
 * the origin.
 */
function stampEnvelope<T>(
  address: string,
  input: MessageEnvelopeInput<T>,
  currentNode: NodeId,
): MessageEnvelope<T> {
  return {
    addressedTo: address,
    type: input.type,
    messageId: input.messageId ?? ulid(),
    timestamp: Date.now(),
    from: input.from ?? `node:${currentNode}`,
    ...(input.parentOpId !== undefined ? { parentOpId: input.parentOpId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
}

/**
 * Extract the asker-node id from a `@cluster/asks:<nodeId>` address.
 * Returns `null` for malformed inputs so the caller can diagnose.
 */
function extractAskerNode(replyAddress: string): NodeId | null {
  const prefix = "@cluster/asks:";
  if (!replyAddress.startsWith(prefix)) return null;
  return replyAddress.slice(prefix.length) || null;
}

/**
 * Map an Effect `Cause` from a local.ask invocation to the wire-side
 * response payload. Typed handler failures (`Effect.fail` with the
 * `MessageHandlerError` shape) survive round-trip; unexpected
 * failures (defects, runtime errors) collapse into a synthetic
 * `MessageHandlerError`.
 */
function causeToAskFailure(
  cause: Cause.Cause<InboxError | MessageHandlerError>,
): ClusterAskResponsePayload {
  if (Cause.isInterruptedOnly(cause)) {
    return { _tag: "interrupt" };
  }
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    // The Effect's `E` channel includes both `InboxError` (routing-side)
    // and `MessageHandlerError` (handler-side). Only the latter is a
    // valid wire payload for a remote handler failure — InboxError
    // bubbling here means the local.ask itself failed before reaching
    // the handler (no registration, inbox closed). Synthesize a
    // `HandlerError` for the asker so the wire payload stays typed.
    const value = failure.value;
    if (isMessageHandlerError(value)) {
      return { _tag: "fail", error: value };
    }
    return {
      _tag: "fail",
      error: { _tag: "HandlerError", cause: value },
    };
  }
  // Defect — synthesize a HandlerError so the asker sees a typed
  // failure rather than an opaque routing problem.
  return {
    _tag: "fail",
    error: { _tag: "HandlerError", cause: new Error(Cause.pretty(cause)) },
  };
}

function isMessageHandlerError(value: unknown): value is MessageHandlerError {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { _tag?: unknown })._tag;
  return tag === "HandlerError" || tag === "InvalidPayload";
}
