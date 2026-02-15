import type { AgentickClient } from "@agentick/client";
import { MessageLog, ToolConfirmations } from "@agentick/client";
import type { StreamEvent, SendInput, ToolConfirmationResponse } from "@agentick/shared";
import type { ToolConfirmationRequest } from "@agentick/shared";
import type {
  ConnectorConfig,
  ConnectorOutput,
  ConnectorStatus,
  ConnectorStatusEvent,
  RetryConfig,
} from "./types.js";
import { buildContentFilter, applyContentPolicy } from "./content-pipeline.js";
import type { ContentPolicyFn } from "./types.js";
import { DeliveryBuffer, RateLimiter } from "./delivery-buffer.js";

interface ResolvedRetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  onExhausted?: RetryConfig["onExhausted"];
}

let syntheticIdCounter = 0;

/**
 * Bridges an Agentick session to a connector platform.
 *
 * Composes `MessageLog` + `ToolConfirmations` with `subscribe: false`
 * and a single event fan-out — same pattern as `ChatSession`, but
 * without UI concerns (MessageSteering, LineEditor, AttachmentManager).
 *
 * Adds content pipeline (filtering/transformation) and delivery strategy
 * (buffered outbound) on top.
 */
export class ConnectorSession {
  private readonly _messageLog: MessageLog;
  private readonly _confirmations: ToolConfirmations;
  private readonly _contentFilter: ContentPolicyFn;
  private readonly _deliveryBuffer: DeliveryBuffer;
  private readonly _rateLimiter: RateLimiter | null;
  private readonly _retryConfig: ResolvedRetryConfig;
  private readonly _accessor;

  private _isExecuting = false;
  private _destroyed = false;
  private _lastDeliveredCount = 0;
  private _status: ConnectorStatus = "disconnected";

  private _deliverListeners = new Set<(output: ConnectorOutput) => void | Promise<void>>();
  private _confirmationListeners = new Set<
    (request: ToolConfirmationRequest, respond: (r: ToolConfirmationResponse) => void) => void
  >();
  private _statusListeners = new Set<(event: ConnectorStatusEvent) => void>();
  private _executionStartListeners = new Set<() => void>();
  private _executionEndListeners = new Set<() => void>();

  private _retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private _unsubscribeEvents: (() => void) | null = null;
  private _unsubscribeConfirmations: (() => void) | null = null;

  constructor(client: AgentickClient, config: ConnectorConfig) {
    const sessionId = config.sessionId;

    this._contentFilter = buildContentFilter(
      config.contentPolicy ?? "text-only",
      config.toolSummarizer,
    );

    this._rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit) : null;

    const retry = config.retry ?? {};
    this._retryConfig = {
      maxAttempts: retry.maxAttempts ?? 3,
      baseDelay: retry.baseDelay ?? 1000,
      maxDelay: retry.maxDelay ?? 30_000,
      onExhausted: retry.onExhausted,
    };

    // Create primitives in externally-driven mode
    this._messageLog = new MessageLog(client, {
      sessionId,
      renderMode: config.renderMode ?? "message",
      subscribe: false,
    });

    this._confirmations = new ToolConfirmations(client, {
      sessionId,
      policy: config.confirmationPolicy,
      subscribe: false,
    });

    // Delivery buffer controls outbound timing
    this._deliveryBuffer = new DeliveryBuffer({
      strategy: config.deliveryStrategy ?? "on-idle",
      debounceMs: config.debounceMs ?? 1500,
      onDeliver: () => this._emitDelivery(),
    });

    // Single event subscription — fan out to message log + delivery buffer
    const accessor = client.session(sessionId);
    this._accessor = accessor;

    if (config.autoSubscribe !== false) {
      accessor.subscribe();
    }

    this._unsubscribeEvents = accessor.onEvent((event: StreamEvent) => {
      this._messageLog.processEvent(event);

      if (event.type === "execution_start") {
        this._isExecuting = true;
        for (const listener of this._executionStartListeners) {
          try {
            listener();
          } catch (e) {
            console.error("Error in execution start listener:", e);
          }
        }
      }

      if (event.type === "execution_end") {
        this._isExecuting = false;
        for (const listener of this._executionEndListeners) {
          try {
            listener();
          } catch (e) {
            console.error("Error in execution end listener:", e);
          }
        }
        this._deliveryBuffer.markIdle();
        return;
      }

      // Poke delivery buffer on message changes
      if (this._hasNewContent()) {
        this._deliveryBuffer.poke();
      }
    });

    this._unsubscribeConfirmations = accessor.onToolConfirmation((request, respond) => {
      this._confirmations.handleConfirmation(request, respond);
      // Notify connector listeners
      for (const listener of this._confirmationListeners) {
        try {
          listener(request, respond);
        } catch (e) {
          console.error("Error in connector confirmation listener:", e);
        }
      }
    });
  }

  // --- Public API ---

  get status(): ConnectorStatus {
    return this._status;
  }

  send(text: string): void {
    if (this._checkRateLimit()) return;
    this._accessor.send({ messages: [{ role: "user", content: [{ type: "text", text }] }] });
  }

  sendInput(input: SendInput): void {
    if (this._checkRateLimit()) return;
    this._accessor.send(input);
  }

  respondToConfirmation(response: ToolConfirmationResponse): void {
    this._confirmations.respond(response);
  }

  abort(reason?: string): void {
    this._accessor.abort(reason);
  }

  reportStatus(status: ConnectorStatus, error?: Error): void {
    this._status = status;
    const event: ConnectorStatusEvent = { status };
    if (error) event.error = error;
    for (const listener of this._statusListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("Error in connector status listener:", e);
      }
    }
  }

  onStatus(handler: (event: ConnectorStatusEvent) => void): () => void {
    this._statusListeners.add(handler);
    return () => this._statusListeners.delete(handler);
  }

  onDeliver(handler: (output: ConnectorOutput) => void | Promise<void>): () => void {
    this._deliverListeners.add(handler);
    return () => this._deliverListeners.delete(handler);
  }

  onConfirmation(
    handler: (
      request: ToolConfirmationRequest,
      respond: (r: ToolConfirmationResponse) => void,
    ) => void,
  ): () => void {
    this._confirmationListeners.add(handler);
    return () => this._confirmationListeners.delete(handler);
  }

  onExecutionStart(handler: () => void): () => void {
    this._executionStartListeners.add(handler);
    return () => this._executionStartListeners.delete(handler);
  }

  onExecutionEnd(handler: () => void): () => void {
    this._executionEndListeners.add(handler);
    return () => this._executionEndListeners.delete(handler);
  }

  destroy(): void {
    this._destroyed = true;
    this._unsubscribeEvents?.();
    this._unsubscribeConfirmations?.();
    this._messageLog.destroy();
    this._confirmations.destroy();
    this._deliveryBuffer.destroy();
    for (const timer of this._retryTimers) clearTimeout(timer);
    this._retryTimers.clear();
    this._deliverListeners.clear();
    this._confirmationListeners.clear();
    this._statusListeners.clear();
    this._executionStartListeners.clear();
    this._executionEndListeners.clear();
  }

  // --- Private ---

  /** Returns true if rate-limited (caller should bail). */
  private _checkRateLimit(): boolean {
    if (!this._rateLimiter) return false;
    const check = this._rateLimiter.check();
    if (check.allowed) return false;
    if (check.reply) this._emitSyntheticMessage(check.reply);
    return true;
  }

  private _hasNewContent(): boolean {
    return this._messageLog.messages.length > this._lastDeliveredCount;
  }

  private _emitDelivery(): void {
    const allMessages = this._messageLog.messages;
    const newMessages = allMessages.slice(this._lastDeliveredCount);
    this._lastDeliveredCount = allMessages.length;

    if (newMessages.length === 0) return;

    // Only deliver assistant messages — user messages originated from an input
    // source and should never be echoed back to the platform.
    const assistantOnly = newMessages.filter((m) => m.role === "assistant");
    if (assistantOnly.length === 0 && this._isExecuting) return;

    const filtered = applyContentPolicy(assistantOnly, this._contentFilter);
    const isComplete = !this._isExecuting;

    if (filtered.length === 0 && !isComplete) return;

    const output: ConnectorOutput = {
      messages: filtered,
      isComplete,
    };

    for (const listener of this._deliverListeners) {
      this._deliverWithRetry(listener, output);
    }
  }

  private _deliverWithRetry(
    listener: (output: ConnectorOutput) => void | Promise<void>,
    output: ConnectorOutput,
    attempt = 0,
  ): void {
    try {
      const result = listener(output);
      if (result && typeof result.then === "function") {
        result.then(undefined, (err: unknown) => {
          this._handleDeliveryError(err as Error, listener, output, attempt);
        });
      }
    } catch (err) {
      this._handleDeliveryError(err as Error, listener, output, attempt);
    }
  }

  private _handleDeliveryError(
    err: Error,
    listener: (output: ConnectorOutput) => void | Promise<void>,
    output: ConnectorOutput,
    attempt: number,
  ): void {
    if (this._destroyed) return;

    const nextAttempt = attempt + 1;
    if (nextAttempt >= this._retryConfig.maxAttempts) {
      console.error(`Delivery failed after ${this._retryConfig.maxAttempts} attempts:`, err);
      this._retryConfig.onExhausted?.(err, output);
      return;
    }

    const delay = Math.min(this._retryConfig.baseDelay * 2 ** attempt, this._retryConfig.maxDelay);
    const timer = setTimeout(() => {
      this._retryTimers.delete(timer);
      this._deliverWithRetry(listener, output, nextAttempt);
    }, delay);
    this._retryTimers.add(timer);
  }

  private _emitSyntheticMessage(text: string): void {
    const output: ConnectorOutput = {
      messages: [
        {
          id: `synthetic_${++syntheticIdCounter}`,
          role: "assistant",
          content: text,
        },
      ],
      isComplete: true,
    };

    for (const listener of this._deliverListeners) {
      try {
        listener(output);
      } catch (e) {
        console.error("Error in connector delivery listener:", e);
      }
    }
  }
}
