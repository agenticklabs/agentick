import { EventEmitter } from "node:events";
import type { KernelContext } from "./context";
import { Context } from "./context";
import { Telemetry } from "./telemetry";

/**
 * Target specification for event routing.
 * Used by transports to determine which connections receive the event.
 *
 * Inspired by Socket.io patterns:
 * - emit: send to target (may include sender)
 * - broadcast: send to target excluding sender
 */
export interface ChannelTarget {
  /**
   * Send to specific connection by ID.
   */
  connectionId?: string;

  /**
   * Send to all connections in these rooms.
   * Rooms are arbitrary strings - application decides naming convention.
   * Examples: 'user:123', 'tenant:abc', 'thread:xyz'
   */
  rooms?: string[];

  /**
   * Broadcast mode: exclude the source connection from delivery.
   * Requires metadata.sourceConnectionId to be set.
   *
   * Mimics Socket.io's socket.broadcast.emit() pattern:
   * - false (default): emit to all targets including sender
   * - true: broadcast to all targets except sender
   */
  excludeSender?: boolean;
}

/**
 * Normalized channel event structure.
 * Loosely structured but normalized for consistency.
 */
export interface ChannelEvent {
  /**
   * Event type (normalized patterns: 'request', 'response', 'progress', 'status', 'error')
   */
  type: string;

  /**
   * Request/response correlation ID (for bidirectional communication)
   */
  id?: string;

  /**
   * Channel name (e.g., 'ui:progress', 'ui:user-input', 'tool:status')
   */
  channel: string;

  /**
   * Flexible event payload
   */
  payload: any;

  /**
   * Optional metadata
   */
  metadata?: {
    timestamp?: number;
    source?: string; // 'tool', 'component', 'ui', 'system'
    executionId?: string;
    tick?: number;
    sourceConnectionId?: string; // Connection that originated this event
    [key: string]: unknown;
  };

  /**
   * Optional routing target.
   * If not specified, event is broadcast to all channel subscribers.
   * Used by transports for targeted delivery.
   */
  target?: ChannelTarget;
}

/**
 * Core Channel primitive.
 * Works standalone in any Node environment.
 * Uses EventEmitter internally for pub/sub.
 */
export class Channel {
  private emitter = new EventEmitter();
  private pendingRequests = new Map<
    string,
    {
      resolve: (event: ChannelEvent) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  // Store recent responses to handle race conditions (response before wait)
  private recentResponses = new Map<string, ChannelEvent>();

  constructor(public readonly name: string) {}

  /**
   * Publish an event to the channel.
   */
  publish(event: ChannelEvent): void {
    // Ensure channel name matches
    const normalizedEvent: ChannelEvent = {
      ...event,
      channel: this.name,
      metadata: {
        timestamp: Date.now(),
        ...event.metadata,
      },
    };

    // Track channel events as metrics
    const ctx = Context.tryGet();
    if (ctx?.procedureGraph && ctx.procedurePid) {
      const node = ctx.procedureGraph.get(ctx.procedurePid);
      if (node) {
        // Track as metric in node
        node.addMetric(`channel.${this.name}.events`, 1);

        // Also track in context metrics (for consistency)
        if (ctx.metrics) {
          ctx.metrics[`channel.${this.name}.events`] =
            (ctx.metrics[`channel.${this.name}.events`] || 0) + 1;
        }

        // Send to telemetry immediately
        Telemetry.getCounter(`channel.${this.name}.events`).add(1, {
          channel: this.name,
          event_type: normalizedEvent.type,
          procedure: node.name || "anonymous",
          procedure_pid: node.pid,
        });
      }
    }

    // Emit to all subscribers
    this.emitter.emit("event", normalizedEvent);

    // If this is a response, resolve any pending requests or store for later
    if (normalizedEvent.type === "response" && normalizedEvent.id) {
      const responseId = normalizedEvent.id; // Type guard
      const pending = this.pendingRequests.get(responseId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(responseId);
        pending.resolve(normalizedEvent);
      } else {
        // Store response in case waitForResponse is called later (race condition)
        this.recentResponses.set(responseId, normalizedEvent);
        // Clean up after 5 seconds
        setTimeout(() => {
          this.recentResponses.delete(responseId);
        }, 5000);
      }
    }
  }

  /**
   * Subscribe to events on this channel.
   * @returns Unsubscribe function
   */
  subscribe(handler: (event: ChannelEvent) => void): () => void {
    this.emitter.on("event", handler);

    return () => {
      this.emitter.off("event", handler);
    };
  }

  /**
   * Wait for a response to a specific request.
   * Used by tools/components for bidirectional communication.
   *
   * @param requestId The request ID to wait for
   * @param timeoutMs Timeout in milliseconds (default: 30000)
   * @returns Promise that resolves when response is received
   */
  waitForResponse(requestId: string, timeoutMs: number = 30000): Promise<ChannelEvent> {
    return new Promise((resolve, reject) => {
      // Check if response was already received (race condition: response before wait)
      const cachedResponse = this.recentResponses.get(requestId);
      if (cachedResponse) {
        this.recentResponses.delete(requestId);
        resolve(cachedResponse);
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new Error(
            `Channel "${this.name}": Request "${requestId}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });

      // Subscribe to catch responses that arrive after we set up the pending request
      const unsubscribe = this.subscribe((event) => {
        if (event.type === "response" && event.id === requestId) {
          unsubscribe();
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          resolve(event);
        }
      });
    });
  }

  /**
   * Get the number of active subscribers.
   */
  getSubscriberCount(): number {
    return this.emitter.listenerCount("event");
  }

  /**
   * Cleanup: remove all subscribers and pending requests.
   */
  destroy(): void {
    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new Error(`Channel "${this.name}" destroyed while waiting for request "${requestId}"`),
      );
    }
    this.pendingRequests.clear();

    // Clear cached responses
    this.recentResponses.clear();

    // Remove all listeners
    this.emitter.removeAllListeners();
  }
}

/**
 * Channel session manages a collection of channels.
 * Sessions persist across multiple engine executions.
 */
export class ChannelSession {
  public readonly channels = new Map<string, Channel>();
  public readonly createdAt: number;
  public lastActivity: number;

  constructor(public readonly id: string) {
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  /**
   * Get or create a channel within this session.
   */
  getChannel(name: string): Channel {
    if (!this.channels.has(name)) {
      this.channels.set(name, new Channel(name));
    }
    this.lastActivity = Date.now();
    return this.channels.get(name)!;
  }

  /**
   * Remove a channel from the session.
   */
  removeChannel(name: string): void {
    const channel = this.channels.get(name);
    if (channel) {
      channel.destroy();
      this.channels.delete(name);
    }
  }

  /**
   * Default session ID generator.
   * Uses user context + conversation ID or trace ID.
   * Users can override this via ChannelService config.
   */
  static generateId(ctx: KernelContext): string {
    const userId = ctx.user?.id || "anonymous";
    // Use conversationId if present and not 'na', otherwise fall back to traceId
    const conversationId =
      ctx.metadata["conversationId"] && ctx.metadata["conversationId"] !== "na"
        ? ctx.metadata["conversationId"]
        : ctx.traceId;
    return `${userId}-${conversationId}`;
  }

  /**
   * Cleanup all channels in the session.
   */
  destroy(): void {
    for (const channel of this.channels.values()) {
      channel.destroy();
    }
    this.channels.clear();
  }
}

/**
 * Kernel-level interface for channel service access.
 * This allows KernelContext to reference channels without creating
 * a circular dependency between kernel and engine packages.
 *
 * Engine's ChannelService implements this interface.
 */
export interface ChannelServiceInterface {
  /**
   * Get or create a channel within the current session.
   * Session is determined from the provided context.
   */
  getChannel(ctx: KernelContext, channelName: string): Channel;

  /**
   * Publish an event to a channel.
   */
  publish(ctx: KernelContext, channelName: string, event: Omit<ChannelEvent, "channel">): void;

  /**
   * Subscribe to events on a channel.
   * @returns Unsubscribe function
   */
  subscribe(
    ctx: KernelContext,
    channelName: string,
    handler: (event: ChannelEvent) => void,
  ): () => void;

  /**
   * Wait for a response on a channel (for bidirectional communication).
   */
  waitForResponse(
    ctx: KernelContext,
    channelName: string,
    requestId: string,
    timeoutMs?: number,
  ): Promise<ChannelEvent>;
}
