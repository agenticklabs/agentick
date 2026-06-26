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
 *     the pending correlationId, resolves the Deferred, and the
 *     `ask` Effect completes with the original typed error preserved
 *     (both `MessageHandlerError` and `InboxError` round-trip
 *     structurally — see {@link ClusterAskResponsePayload}).
 *
 * Inbound dispatch (`transport.subscribeInbox({})` callback):
 *   - `@cluster/ask`           → validate, unwrap, run local.ask, ship reply
 *   - `@cluster/ask-response`  → validate, resolve pending Deferred by correlationId
 *   - everything else (adopter tells / forwarded sends) → `local.send`
 *     so the registered handler picks it up exactly as if it had
 *     arrived locally. Idempotency is preserved (the original
 *     `messageId` is carried through).
 *
 * The cluster-internal namespace `@cluster/*` is RESERVED. `register`,
 * `send`, and `ask` reject adopter use of that prefix with
 * `RoutingFailed`. Without enforcement, adopter code could register
 * a handler at `@cluster/asks:node-X` and intercept ask responses,
 * or send a forged `@cluster/ask-response` envelope to resolve a
 * pending Deferred with attacker-controlled data.
 *
 * Wire payloads are validated at the inbound boundary. Any envelope
 * that fails the shape check emits `cluster:ask:invalid-payload` and
 * is dropped — we never trust the `unknown` payload past a runtime
 * validator.
 *
 * Caller-interrupt cleanup: `askRemote` returns an `Effect.async` with
 * a cancel hook that clears the pendingAsks entry + timeoutHandle
 * when the asker's Effect is interrupted. Without this, a fiber
 * cancellation orphans the Map entry until the timeout fires.
 *
 * Diagnostics emitted on the LOCAL bus (`surface: "cluster"`):
 *   - `cluster:transport:send:failed`         transport.send rejected
 *   - `cluster:routing:address-not-found`     inbound dispatched to no handler
 *   - `cluster:ask:dispatched`                remote ask forwarded
 *   - `cluster:ask:resolved`                  remote ask completed
 *   - `cluster:ask:timeout`                   remote ask exceeded timeoutMs
 *   - `cluster:ask:interrupted`               asker interrupted before response
 *   - `cluster:ask:response-orphaned`         response arrived past pending entry
 *   - `cluster:ask:invalid-payload`           wire payload failed shape validation
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
import { ulid, omitUndefined } from "@agentick/utils-next";

import type { ClusterPartitioning } from "../partitioning.js";
import type { ClusterTransport } from "../transport.js";
import type { NodeId } from "../types.js";
import { DiagnosticEmitter, makeDiagnostics } from "./diagnostics.js";
import {
  CLUSTER_ASK_RESPONSE_TYPE,
  CLUSTER_ASK_TYPE,
  CLUSTER_NS_PREFIX,
  clusterReplyAddress,
  isClusterAskRequest,
  isClusterAskRequestPayload,
  isClusterAskResponse,
  isClusterAskResponsePayload,
  isInboxError,
  isMessageHandlerError,
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
 * until the response envelope arrives, the timeout fires, or the
 * asker's Effect is interrupted.
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
   * a remote node. Cleared on response arrival, timeout, or caller
   * interrupt.
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
    if (address.startsWith(CLUSTER_NS_PREFIX)) {
      return Effect.fail<InboxError>({
        _tag: "RoutingFailed",
        cause: new Error(
          `address "${address}" uses reserved cluster namespace "${CLUSTER_NS_PREFIX}"`,
        ),
      });
    }
    return this.local.register(address, handler);
  }

  send<T = unknown>(
    address: string,
    input: MessageEnvelopeInput<T>,
  ): Effect.Effect<MessageAck, InboxError, never> {
    return Effect.suspend((): Effect.Effect<MessageAck, InboxError, never> => {
      if (this.closed) return Effect.fail({ _tag: "InboxClosed" });
      const guard = this.guardReservedNamespace(address, input.type);
      if (guard) return Effect.fail(guard);
      return Effect.flatMap(
        Effect.promise(() => this.resolveOwner(address)),
        (owner) => {
          if (owner === this.currentNode) return this.local.send(address, input);
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
      const guard = this.guardReservedNamespace(address, input.type);
      if (guard) return Effect.fail(guard);
      return Effect.flatMap(
        Effect.promise(() => this.resolveOwner(address)),
        (owner): Effect.Effect<R, InboxError | MessageHandlerError, never> => {
          if (owner === this.currentNode) return this.local.ask<T, R>(address, input, options);
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

  /**
   * Reject adopter attempts to use the reserved cluster namespace at
   * the address or type level. Returns the error to fail with, or
   * `null` to allow the operation.
   */
  private guardReservedNamespace(address: string, type: string): InboxError | null {
    if (address.startsWith(CLUSTER_NS_PREFIX)) {
      return {
        _tag: "RoutingFailed",
        cause: new Error(
          `address "${address}" uses reserved cluster namespace "${CLUSTER_NS_PREFIX}"`,
        ),
      };
    }
    if (type.startsWith(CLUSTER_NS_PREFIX)) {
      return {
        _tag: "RoutingFailed",
        cause: new Error(`type "${type}" uses reserved cluster namespace "${CLUSTER_NS_PREFIX}"`),
      };
    }
    return null;
  }

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
   * response (or timeout, or caller interrupt) resolves the returned
   * Effect.
   */
  private askRemote<T, R>(
    owner: NodeId,
    address: string,
    input: MessageEnvelopeInput<T>,
    options?: AskOptions,
  ): Effect.Effect<R, InboxError | MessageHandlerError, never> {
    const correlationId = ulid();
    const timeoutMs = options?.timeoutMs ?? 30_000;

    const askPayload: ClusterAskRequestPayload<T> = {
      innerType: input.type,
      ...omitUndefined({
        innerPayload: input.payload,
        innerFrom: input.from,
        innerParentOpId: input.parentOpId,
        innerCorrelationId: input.correlationId,
      }),
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

      // Fire the wire send. Transport rejection cleans up + fails the
      // pending entry immediately.
      this.transport.send(owner, env as MessageEnvelope).catch((cause) => {
        const pending = this.pendingAsks.get(correlationId);
        if (!pending) return;
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

      // Cancel hook: fires on Fiber.interrupt of the asker's surrounding
      // scope. Clear the pending entry + timeout so they don't leak
      // until the timeout naturally fires.
      return Effect.sync(() => {
        const pending = this.pendingAsks.get(correlationId);
        if (!pending) return;
        this.pendingAsks.delete(correlationId);
        clearTimeout(pending.timeoutHandle);
        this.diag.emit("cluster:ask:interrupted", { target: owner, address, correlationId });
      });
    });
  }

  // ============================================================================
  // Internals — inbound
  // ============================================================================

  private dispatchInbound(env: MessageEnvelope): void {
    if (this.closed) return;

    if (isClusterAskRequest(env)) {
      this.handleInboundAskRequest(env);
      return;
    }

    if (isClusterAskResponse(env)) {
      this.handleInboundAskResponse(env);
      return;
    }

    this.dispatchAdopterTell(env);
  }

  /**
   * Server side of a cross-node ask. The inbound envelope is treated
   * as `unknown` payload until validated; we never feed an unchecked
   * payload into `local.ask`.
   */
  private handleInboundAskRequest(env: MessageEnvelope): void {
    if (!env.from || !env.correlationId) {
      this.diag.emit("cluster:ask:invalid-payload", {
        side: "request",
        messageId: env.messageId,
        reason: "missing-from-or-correlation",
      });
      return;
    }
    if (!isClusterAskRequestPayload(env.payload)) {
      this.diag.emit("cluster:ask:invalid-payload", {
        side: "request",
        messageId: env.messageId,
        correlationId: env.correlationId,
        reason: "payload-shape",
      });
      return;
    }

    const askPayload = env.payload;
    const innerInput: MessageEnvelopeInput = {
      type: askPayload.innerType,
      ...omitUndefined({
        payload: askPayload.innerPayload,
        from: askPayload.innerFrom,
        parentOpId: askPayload.innerParentOpId,
        correlationId: askPayload.innerCorrelationId,
      }),
    };

    const askOptions: AskOptions | undefined =
      askPayload.timeoutMs !== undefined ? { timeoutMs: askPayload.timeoutMs } : undefined;

    const program = this.local.ask(env.addressedTo, innerInput, askOptions).pipe(
      Effect.matchCauseEffect({
        onSuccess: (value): Effect.Effect<void, never, never> =>
          this.shipAskResponse(env, { _tag: "success", value }),
        onFailure: (cause): Effect.Effect<void, never, never> =>
          this.shipAskResponse(env, causeToAskFailure(cause)),
      }),
    );

    Effect.runFork(program);
  }

  /**
   * Asker side: a response envelope arrived. Validate the payload
   * shape before trusting it; look up its correlationId; clear the
   * timeout; resolve/reject the pending Effect with a typed error
   * (both `MessageHandlerError` and `InboxError` round-trip
   * structurally — see {@link ClusterAskResponsePayload}).
   */
  private handleInboundAskResponse(env: MessageEnvelope): void {
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

    // Validate the payload before consuming it. A malformed payload
    // is dropped + diagnosed; the pending entry stays so the timeout
    // can eventually fire (or close() clears it). Without this the
    // asker would resolve to `undefined` or a corrupted value typed
    // as R.
    if (!isClusterAskResponsePayload(env.payload)) {
      this.diag.emit("cluster:ask:invalid-payload", {
        side: "response",
        messageId: env.messageId,
        correlationId: env.correlationId,
        reason: "payload-shape",
      });
      return;
    }

    this.pendingAsks.delete(env.correlationId);
    clearTimeout(pending.timeoutHandle);

    const payload = env.payload;
    this.diag.emit("cluster:ask:resolved", {
      correlationId: env.correlationId,
      outcome: payload._tag,
    });
    switch (payload._tag) {
      case "success":
        pending.resolve(payload.value);
        return;
      case "handler-fail":
        pending.reject(payload.error);
        return;
      case "routing-fail":
        pending.reject(payload.error);
        return;
      case "interrupt":
        // Remote handler's fiber was interrupted (e.g., remote inbox
        // closed mid-call). Surface as RoutingFailed so adopter sees
        // a non-success outcome without inventing a new spec tag.
        pending.reject({
          _tag: "RoutingFailed",
          cause: new Error("remote handler was interrupted"),
        });
        return;
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
      ...omitUndefined({
        from: env.from,
        parentOpId: env.parentOpId,
        correlationId: env.correlationId,
        payload: env.payload,
      }),
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
            // RoutingFailed / other tags fall through silently; the
            // LOCAL inbox's onTellError pathway already surfaces
            // handler-side problems.
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
    request: MessageEnvelope,
    payload: ClusterAskResponsePayload,
  ): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const askerReplyAddress = request.from ?? clusterReplyAddress("unknown");
      const askerNode = extractAskerNode(askerReplyAddress);
      if (!askerNode || !request.correlationId) {
        this.diag.emit("cluster:ask:invalid-payload", {
          side: "request",
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
    ...omitUndefined({
      parentOpId: input.parentOpId,
      correlationId: input.correlationId,
      payload: input.payload,
    }),
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
 * Map an Effect `Cause` from a `local.ask` invocation to the wire-side
 * response payload. The `E` channel of `local.ask` is
 * `InboxError | MessageHandlerError`; both are preserved structurally
 * across the wire via the discriminated `handler-fail` vs
 * `routing-fail` tags on {@link ClusterAskResponsePayload}.
 *
 *   - Interrupt-only causes  → `{ _tag: "interrupt" }`
 *   - `MessageHandlerError`  → `{ _tag: "handler-fail", error }`
 *   - `InboxError`           → `{ _tag: "routing-fail", error }`
 *   - Defects / unknowns     → synthesized `HandlerError` (`handler-fail`)
 */
function causeToAskFailure(
  cause: Cause.Cause<InboxError | MessageHandlerError>,
): ClusterAskResponsePayload {
  if (Cause.isInterruptedOnly(cause)) {
    return { _tag: "interrupt" };
  }
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    const value = failure.value;
    if (isMessageHandlerError(value)) return { _tag: "handler-fail", error: value };
    if (isInboxError(value)) return { _tag: "routing-fail", error: value };
  }
  // Defect / unknown — synthesize a HandlerError so the asker sees a
  // typed failure rather than nothing.
  return {
    _tag: "handler-fail",
    error: { _tag: "HandlerError", cause: new Error(Cause.pretty(cause)) },
  };
}
