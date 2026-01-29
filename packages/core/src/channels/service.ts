import {
  Channel,
  ChannelSession,
  type ChannelEvent,
  type ChannelServiceInterface,
  type ChannelTarget,
  Context,
} from "../core/index.js";
import type { EngineContext } from "../types";
import { NotFoundError, ValidationError } from "@tentickle/shared";

// Re-export channel types from Kernel so Engine users don't need to import from Kernel
export {
  Channel,
  ChannelSession,
  type ChannelEvent,
  type ChannelServiceInterface,
  type ChannelTarget,
} from "../core/index.js";

/**
 * Connection metadata for routing decisions.
 * Provided when connecting, used by transport for auto-join and routing.
 */
export interface ConnectionMetadata {
  /** User ID - for auto-joining user rooms */
  userId?: string;
  /** Tenant ID - for auto-joining tenant rooms */
  tenantId?: string;
  /** Any additional metadata for custom routing */
  [key: string]: unknown;
}

/**
 * Configuration for ChannelTransport.
 */
export interface ChannelTransportConfig {
  /**
   * Auto-join rooms based on connection metadata.
   * Called on connect with the connection's metadata.
   * Return array of room names to automatically join.
   *
   * @example
   * ```typescript
   * autoJoinRooms: (meta) => [
   *   meta.userId && `user:${meta.userId}`,
   *   meta.tenantId && `tenant:${meta.tenantId}`,
   * ].filter(Boolean)
   * ```
   */
  autoJoinRooms?: (metadata: ConnectionMetadata) => string[];
}

/**
 * Transport adapter for external communication (e.g., SSE, WebSocket).
 * Optional add-on layer - channels work without transport.
 *
 * Supports room-based routing (inspired by Socket.io):
 * - Connections can join/leave rooms
 * - Events can target specific rooms
 * - excludeSender provides "broadcast" semantics (send to others)
 */
export interface ChannelTransport {
  /**
   * Transport name (e.g., 'sse', 'websocket')
   */
  name: string;

  /**
   * Connect a client with optional metadata.
   * Metadata is used for routing (userId, tenantId, etc.) and auto-join.
   */
  connect(connectionId: string, metadata?: ConnectionMetadata): Promise<void>;

  /**
   * Disconnect a client (or all if no connectionId).
   */
  disconnect(connectionId?: string): Promise<void>;

  /**
   * Send an event through the transport.
   * Routing is determined by event.target:
   * - No target: broadcast to all
   * - target.connectionId: send to specific connection
   * - target.rooms: send to connections in rooms
   * - target.excludeSender: exclude source connection (broadcast pattern)
   */
  send(event: ChannelEvent): Promise<void>;

  /**
   * Register handler for events received from transport.
   */
  onReceive(handler: (event: ChannelEvent) => void): void;

  // === Room Support (optional but recommended) ===

  /**
   * Join a room. Connections in the same room receive room-targeted events.
   */
  join?(connectionId: string, room: string): Promise<void>;

  /**
   * Leave a room.
   */
  leave?(connectionId: string, room: string): Promise<void>;

  /**
   * Get rooms a connection has joined.
   */
  getConnectionRooms?(connectionId: string): string[];

  /**
   * Get connections in a room.
   */
  getRoomConnections?(room: string): string[];

  /**
   * Close all connections.
   */
  closeAll(): void;
}

/**
 * Distribution adapter for multi-instance setups (e.g., Redis pub/sub).
 * Optional add-on layer - channels work without distribution.
 *
 * For room-based routing in distributed setups:
 * - Adapter subscribes to room channels (e.g., Redis `room:{roomName}`)
 * - When event.target.rooms is set, adapter publishes to those room channels
 * - Each instance receives and filters to its local connections
 */
export interface ChannelAdapter {
  /**
   * Adapter name (e.g., 'redis')
   */
  name: string;

  /**
   * Publish event to distribution layer.
   * If event.target.rooms is set, publish to room-specific channels.
   */
  publish(event: ChannelEvent): Promise<void>;

  /**
   * Subscribe to events from distribution layer.
   */
  subscribe(channel: string, handler: (event: ChannelEvent) => void): Promise<() => void>;

  // === Room Support (optional) ===

  /**
   * Subscribe this instance to a room.
   * Called when a local connection joins a room.
   * Adapter should subscribe to the room's distribution channel (e.g., Redis `room:{room}`).
   */
  joinRoom?(room: string): Promise<void>;

  /**
   * Unsubscribe this instance from a room.
   * Called when no local connections remain in the room.
   */
  leaveRoom?(room: string): Promise<void>;

  /**
   * Close the adapter connection (cleanup on shutdown).
   */
  close?(): Promise<void>;
}

/**
 * Channel service configuration.
 */
export interface ChannelServiceConfig {
  /**
   * Custom session ID generator.
   * Default: Uses user context + conversation ID or trace ID.
   */
  sessionIdGenerator?: (ctx: EngineContext) => string;

  /**
   * Optional transport adapter (e.g., Streamable HTTP, WebSocket).
   */
  transport?: ChannelTransport;

  /**
   * Optional distribution adapter (e.g., Redis pub/sub).
   */
  adapter?: ChannelAdapter;

  /**
   * Session timeout in milliseconds (default: 1 hour).
   * Sessions are cleaned up after inactivity.
   */
  sessionTimeout?: number;

  /**
   * Channel routers to register.
   * Enables handleEvent() dispatch by channel name without if-else chains.
   *
   * @example
   * ```typescript
   * routers: [todoListChannel, scratchpadChannel]
   * ```
   */
  routers?: ChannelRouter<any>[];
}

/**
 * Channel Service - Low-level channel infrastructure.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Application Layer (recommended)                                    │
 * │  └── ChannelRouter - declarative handlers, context registry,       │
 * │                      auto-notifications, scoped publishing          │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  Service Layer (escape hatch)                                       │
 * │  └── ChannelService - sessions, direct publish/subscribe,          │
 * │                       transport & adapter management                │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  Infrastructure Layer                                               │
 * │  ├── Transport - external communication (SSE, WebSocket)           │
 * │  └── Adapter - multi-instance distribution (Redis pub/sub)         │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * **Recommended:** Use `ChannelRouter` for application code.
 * - Register routers with engine: `createEngine({ channels: { routers: [...] } })`
 * - Handle events via `channelService.handleEvent()`
 * - Components register via `router.registerContext()`
 *
 * **Escape hatch:** Direct `ChannelService` methods for advanced cases.
 * - `subscribe()` - low-level channel subscription
 * - `publish()` - low-level event publishing
 *
 * Sessions persist across multiple engine executions.
 */
export class ChannelService implements ChannelServiceInterface {
  private sessions = new Map<string, ChannelSession>();
  private sessionIdGenerator: (ctx: EngineContext) => string;
  private transport?: ChannelTransport;
  private adapter?: ChannelAdapter;
  private sessionTimeout: number;
  private cleanupInterval?: NodeJS.Timeout;
  private adapterSubscriptions = new Map<string, () => void>();
  private routerRegistry = new Map<string, ChannelRouter<any>>();

  constructor(config: ChannelServiceConfig = {}) {
    this.sessionIdGenerator = config.sessionIdGenerator || ChannelSession.generateId;
    this.transport = config.transport;
    this.adapter = config.adapter;
    this.sessionTimeout = config.sessionTimeout || 3600000; // 1 hour default

    // Register channel routers
    if (config.routers) {
      for (const router of config.routers) {
        if (!router.channel) {
          throw ValidationError.required("channel");
        }
        this.routerRegistry.set(router.channel, router);
        router.setChannelService(this);
      }
    }

    // Setup transport if provided
    if (this.transport) {
      this.setupTransport();
    }

    // Setup adapter if provided
    if (this.adapter) {
      this.setupAdapter();
    }

    // Start session cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Get the transport adapter (for external access, e.g., HTTP routes).
   */
  getTransport(): ChannelTransport | undefined {
    return this.transport;
  }

  /**
   * Get a registered channel router by name.
   */
  getRouter<TContext = unknown>(channelName: string): ChannelRouter<TContext> | undefined {
    return this.routerRegistry.get(channelName) as ChannelRouter<TContext> | undefined;
  }

  /**
   * Handle an event by delegating to the appropriate registered router.
   * Eliminates if-else chains in HTTP routes.
   *
   * @param channelName - Name of the channel
   * @param request - Event type and payload
   * @param context - Context passed to the handler
   * @returns Result from the handler (for HTTP response body)
   *
   * @example
   * ```typescript
   * // In HTTP route - no if-else needed
   * const result = await engine.channels?.handleEvent('todo-list',
   *   { type: 'create_task', payload },
   *   { userId, broadcast: true }
   * );
   * res.json({ success: true, ...result });
   * ```
   */
  async handleEvent<TContext = unknown, TResult = unknown>(
    channelName: string,
    request: { type: string; payload: unknown },
    rawContext: Record<string, unknown>,
  ): Promise<TResult | undefined> {
    const router = this.getRouter(channelName);
    if (!router) {
      throw new NotFoundError(
        "channel",
        channelName,
        `Unknown channel. Available channels: ${Array.from(this.routerRegistry.keys()).join(", ")}`,
      );
    }

    // Let router transform context if it has buildContext
    const context = router.buildContext ? router.buildContext(rawContext) : rawContext;

    const event: ChannelEvent = {
      channel: channelName,
      type: request.type,
      payload: request.payload,
      metadata: {},
    };

    // console.log('handleEvent', channelName, request, context, router);

    return router.handle<TResult>(event, context as TContext);
  }

  /**
   * Get or create a session for the current context.
   */
  getSession(ctx: EngineContext): ChannelSession {
    const sessionId = this.sessionIdGenerator(ctx);

    if (!this.sessions.has(sessionId)) {
      const session = new ChannelSession(sessionId);
      this.sessions.set(sessionId, session);

      // Connect transport if available
      if (this.transport) {
        this.transport.connect(sessionId).catch((err) => {
          console.error(`Failed to connect transport for session ${sessionId}:`, err);
        });
      }
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return session;
  }

  /**
   * Get or create a channel within the current session.
   */
  getChannel(ctx: EngineContext, channelName: string): Channel {
    const session = this.getSession(ctx);
    const channel = session.getChannel(channelName);

    // Subscribe to adapter if this is a new channel
    // Use synchronous placeholder to prevent duplicate subscriptions from concurrent calls
    if (this.adapter && !this.adapterSubscriptions.has(channelName)) {
      // Set placeholder immediately to prevent race condition
      // The placeholder is a no-op function that will be replaced with the real unsubscribe
      this.adapterSubscriptions.set(channelName, () => {});

      this.adapter
        .subscribe(channelName, (event: ChannelEvent) => {
          // Only forward if event didn't originate from this instance
          // (prevent feedback loop)
          if (event.metadata?.source !== "local") {
            channel.publish(event);
          }
        })
        .then((unsubscribe) => {
          // Replace placeholder with actual unsubscribe function
          this.adapterSubscriptions.set(channelName, unsubscribe);
        })
        .catch((err) => {
          // Remove placeholder on failure so retry is possible
          this.adapterSubscriptions.delete(channelName);
          console.error(`Failed to subscribe adapter to channel ${channelName}:`, err);
        });
    }

    return channel;
  }

  /**
   * Low-level: Publish an event to a channel.
   *
   * **Prefer using ChannelRouter.publisher() for application code.**
   * This is an escape hatch for advanced use cases.
   */
  publish(ctx: EngineContext, channelName: string, event: Omit<ChannelEvent, "channel">): void {
    const session = this.getSession(ctx);
    const channel = session.getChannel(channelName);
    const fullEvent: ChannelEvent = {
      ...event,
      channel: channelName,
      metadata: {
        ...event.metadata,
        executionId: ctx.traceId,
        sessionId: session.id, // Always include sessionId in metadata
        sourceConnectionId: session.id, // For excludeSender (broadcast) support
      },
    };

    // Publish to local channel
    channel.publish(fullEvent);

    // Forward to transport if available
    if (this.transport) {
      this.transport.send(fullEvent).catch((err) => {
        console.error(`Failed to send event via transport:`, err);
      });
    }

    // Forward to adapter if available
    if (this.adapter) {
      this.adapter.publish(fullEvent).catch((err) => {
        console.error(`Failed to publish event via adapter:`, err);
      });
    }
  }

  /**
   * Low-level: Subscribe to events on a channel with a handler function.
   *
   * **Prefer using ChannelRouter for application code.**
   * This is an escape hatch for advanced use cases.
   */
  subscribe(
    ctx: EngineContext,
    channelName: string,
    handler: (event: ChannelEvent) => void | Promise<void>,
  ): () => void {
    const channel = this.getChannel(ctx, channelName);
    return channel.subscribe(handler);
  }

  /**
   * Low-level: Subscribe to multiple channels at once.
   *
   * **Prefer using ChannelRouter for application code.**
   * This is an escape hatch for advanced use cases.
   *
   * @param ctx - Engine context
   * @param channelNames - Array of channel names to subscribe to, or '*' for all channels
   * @param handler - Handler function that receives events from any subscribed channel
   * @returns Unsubscribe function
   */
  subscribeToChannels(
    ctx: EngineContext,
    channelNames: string[] | "*",
    handler: (event: ChannelEvent) => void,
  ): () => void {
    const session = this.getSession(ctx);
    const unsubscribers: (() => void)[] = [];

    if (channelNames === "*") {
      // Subscribe to all existing channels
      for (const channel of session.channels.values()) {
        unsubscribers.push(channel.subscribe(handler));
      }

      // For future channels, we'll subscribe when they're accessed via getChannel
      // This is handled by subscribing to the session's channel creation
      // Note: This is a best-effort approach - channels created outside getChannel won't be subscribed
    } else {
      // Subscribe to specific channels
      for (const channelName of channelNames) {
        const channel = session.getChannel(channelName);
        unsubscribers.push(channel.subscribe(handler));
      }
    }

    // Return combined unsubscribe function
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  /**
   * Low-level: Subscribe to events filtered by session ID.
   *
   * **Prefer using ChannelRouter for application code.**
   * This is an escape hatch for advanced use cases.
   *
   * @param ctx - Engine context
   * @param channelName - Channel name to subscribe to, or '*' for all channels
   * @param handler - Handler function that receives filtered events
   * @param options - Optional filter options
   * @returns Unsubscribe function
   */
  subscribeFiltered(
    ctx: EngineContext,
    channelName: string | "*",
    handler: (event: ChannelEvent) => void,
    options?: {
      sessionId?: string; // Override session ID filter (default: current session)
      channelFilter?: (channelName: string) => boolean; // Additional channel filter
    },
  ): () => void {
    const session = this.getSession(ctx);
    const targetSessionId = options?.sessionId || session.id;

    // Create filtered handler
    const filteredHandler = (event: ChannelEvent) => {
      // Filter by sessionId
      const eventSessionId = event.metadata?.["sessionId"] as string | undefined;
      if (eventSessionId !== targetSessionId) {
        return; // Skip events not for this session
      }

      // Apply additional channel filter if provided
      if (options?.channelFilter && !options.channelFilter(event.channel)) {
        return;
      }

      // Call original handler
      handler(event);
    };

    // Subscribe using filtered handler
    if (channelName === "*") {
      return this.subscribeToChannels(ctx, "*", filteredHandler);
    } else {
      return this.subscribe(ctx, channelName, filteredHandler);
    }
  }

  /**
   * Wait for a response on a channel (for bidirectional communication).
   */
  async waitForResponse(
    ctx: EngineContext,
    channelName: string,
    requestId: string,
    timeoutMs?: number,
  ): Promise<ChannelEvent> {
    const channel = this.getChannel(ctx, channelName);
    return channel.waitForResponse(requestId, timeoutMs);
  }

  /**
   * Setup transport handlers.
   * Forwards events received from transport to local channels.
   */
  private setupTransport(): void {
    if (!this.transport) return;

    // Forward received events to appropriate channels
    this.transport.onReceive((event: ChannelEvent) => {
      // Extract session ID from event metadata
      const sessionId = event.metadata?.["sessionId"] as string | undefined;
      if (!sessionId) {
        console.warn("Received transport event without sessionId in metadata");
        return;
      }

      // Find session and channel
      const session = this.sessions.get(sessionId);
      if (!session) {
        console.warn(`Received transport event for unknown session: ${sessionId}`);
        return;
      }

      // Publish to local channel
      const channel = session.getChannel(event.channel);
      channel.publish(event);
    });
  }

  /**
   * Setup adapter handlers.
   * Subscribes to channels via adapter and forwards events to local channels.
   */
  private async setupAdapter(): Promise<void> {
    if (!this.adapter) return;

    // We'll subscribe to channels on-demand when they're created
    // This is handled in getChannel() - we check if adapter exists and subscribe
  }

  /**
   * Start cleanup interval for expired sessions.
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastActivity > this.sessionTimeout) {
          this.destroySession(sessionId);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Destroy a session and cleanup resources.
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.destroy();
      this.sessions.delete(sessionId);

      // Disconnect transport if available
      if (this.transport) {
        this.transport.disconnect().catch((err) => {
          console.error(`Failed to disconnect transport for session ${sessionId}:`, err);
        });
      }
    }
  }

  /**
   * Cleanup all sessions and resources.
   */
  destroy(): void {
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Destroy all sessions
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }

    // Close transport (sends proper close events to clients)
    if (this.transport) {
      this.transport.closeAll();
    }

    // Close adapter if available
    if (this.adapter?.close) {
      this.adapter.close().catch((err) => {
        console.error("Failed to close adapter during cleanup:", err);
      });
    }

    // Unsubscribe from all adapter subscriptions
    for (const unsubscribe of this.adapterSubscriptions.values()) {
      unsubscribe();
    }
    this.adapterSubscriptions.clear();
  }
}

/**
 * Scope definition for room-based routing and context matching.
 *
 * - ScopeMapping: { prefix: fieldName } - derives scope key from context field
 * - ScopeMapping[]: multiple mappings - registers for all, dedupes on notify
 * - function: (ctx) => fully qualified scope key(s) like 'user:alice'
 *
 * @example
 * ```typescript
 * // Mapping - prefix + field name
 * scope: { user: 'userId' }  // → 'user:alice' from ctx.userId
 *
 * // Multiple mappings
 * scope: [{ user: 'userId' }, { thread: 'threadId' }]
 *
 * // Function - returns fully qualified key(s)
 * scope: (ctx) => `user:${ctx.userId}`
 * scope: (ctx) => [`user:${ctx.userId}`, `org:${ctx.orgId}`]
 * ```
 */
export type ScopeDefinition = ScopeMapping | ScopeMapping[] | ((ctx: any) => string | string[]);

/**
 * Configuration for ChannelRouter.
 */
export interface ChannelRouterConfig {
  /**
   * Transport for sending events (SSE, WebSocket, etc.)
   * Can be a transport instance or a getter function.
   */
  transport?: ChannelTransport | (() => ChannelTransport);

  /**
   * Channel service for subscribing to events.
   * Typically injected via setChannelService() when router is registered.
   */
  channelService?: ChannelService | (() => ChannelService);

  /**
   * Scope definition for room-based routing and context matching.
   * Maps scope names to context field names.
   *
   * @example
   * ```typescript
   * // Single scope
   * scope: { user: 'userId' }
   * // → .to(id) broadcasts to 'user:{id}'
   * // → registerContext uses ctx.userId for matching
   *
   * // Multiple scopes
   * scope: { user: 'userId', thread: 'threadId' }
   * // → .scope('user').to(id) broadcasts to 'user:{id}'
   * // → .scope('thread').to(id) broadcasts to 'thread:{id}'
   * // → registerContext uses both for matching
   *
   * // Function (advanced)
   * scope: (ctx) => `user:${ctx.userId}`
   * ```
   */
  scope?: ScopeDefinition | (() => ScopeDefinition);

  /**
   * Builder function to transform raw context (e.g., from HTTP) into TSubscribeContext.
   */
  contextBuilder?: (data: any) => any;
}

/**
 * Scope mapping: { prefix: fieldName }
 * Used to derive both room names and scope keys from context.
 *
 * @example
 * ```typescript
 * { user: 'userId' }  // → room 'user:alice', scopeKey 'user:alice'
 * ```
 */
export type ScopeMapping = { [prefix: string]: string };

/**
 * Value or getter function.
 */
export type ValueOrGetter<T> = T | (() => T);

/**
 * Scoped publisher - has scope set, needs .to(id) to complete.
 */
export interface ScopedPublisher {
  /**
   * Set the target ID and get a bound publisher.
   * @param id - Target ID (string or getter function)
   */
  to(id: ValueOrGetter<string>): BoundPublisher;
}

/**
 * Bound publisher - ready to send/broadcast.
 */
export interface BoundPublisher {
  send(event: { type: string; payload: unknown }): Promise<void>;
  broadcast(
    event: { type: string; payload: unknown },
    options?: { sourceConnectionId?: string },
  ): Promise<void>;
}

/**
 * Publisher interface for sending events to channel rooms.
 *
 * @example
 * ```typescript
 * // Given scope config: { user: 'userId', thread: 'threadId' }
 *
 * // Select scope and target
 * publisher.scope('user').to(userId).broadcast(event);    // → room 'user:{userId}'
 * publisher.scope('thread').to(threadId).broadcast(event); // → room 'thread:{threadId}'
 *
 * // Direct .to() uses first scope key from config
 * publisher.to(userId).broadcast(event);  // → room 'user:{userId}'
 * ```
 */
export interface ChannelPublisher {
  /**
   * Select which scope mapping to use for routing.
   *
   * @param scopeKey - Key from scope config (e.g., 'user', 'thread')
   */
  scope(scopeKey: string): ScopedPublisher;

  /**
   * Set the target ID directly (uses first scope key from config).
   * Returns a BoundPublisher ready to send/broadcast.
   *
   * @param id - Target ID (string or getter function)
   */
  to(id: ValueOrGetter<string>): BoundPublisher;
}

/**
 * Event handler type for ChannelRouter.
 * Receives the event and optional subscribe context.
 *
 * @template TContext - Type of the subscribe context
 */
export type ChannelEventHandler<TContext = unknown> = (
  event: ChannelEvent,
  context: TContext,
) => any | Promise<any>;

/**
 * ChannelRouter - Declarative channel event handling and publishing.
 *
 * **This is the recommended way to work with channels in application code.**
 *
 * ## Features
 * - Declarative event handlers via `.on(eventType, handler)`
 * - Scoped publishing via `.publisher().scope('user').to(id).broadcast()`
 * - Execution context registry with auto-notification after handlers return
 * - Auto-cleanup when executions end
 *
 * ## Usage
 *
 * ```typescript
 * // 1. Define router with scope mapping
 * const todoChannel = new ChannelRouter<TodoContext>('todo-list', {
 *   scope: { user: 'userId' },
 * })
 *   .on('create_task', async (event, ctx) => {
 *     return TodoService.createTask(ctx.userId, event.payload);
 *   });
 *
 * // 2. Register with engine (injects ChannelService)
 * createEngine({ channels: { routers: [todoChannel] } });
 *
 * // 3. In components - register for auto-notification
 * const publisher = channel.registerContext(ctx, { userId }, (event, result) => {
 *   if (result?.success) com.setState('tasks', result.tasks);
 * });
 *
 * // 4. Publish events
 * publisher.to(userId).broadcast({ type: 'state_changed', payload });
 *
 * // 5. Cleanup on unmount
 * channel.unregisterContext(ctx);
 * ```
 *
 * @template TSubscribeContext - Type of the context passed to handlers
 */
/**
 * Callback invoked when a channel event is handled.
 * Receives the event and the handler's result.
 */
export type ContextEventCallback<TResult = unknown> = (
  event: ChannelEvent,
  result: TResult,
) => void;

/**
 * Registered context entry for a specific execution + scope
 */
interface RegisteredContext<T> {
  executionId: string;
  context: T;
  /** Callback invoked after handler returns (auto-notify) */
  onEvent?: ContextEventCallback;
}

export class ChannelRouter<TSubscribeContext = unknown> {
  private handlers = new Map<string, ChannelEventHandler<TSubscribeContext>>();
  private defaultHandler?: ChannelEventHandler<TSubscribeContext>;
  private errorHandler?: (error: Error, event: ChannelEvent) => void;

  /**
   * Registry of execution contexts.
   * Key format: `${executionId}:${scopeKey}`
   * Allows multiple executions to register for same scope, each with own callbacks.
   */
  private contextRegistry = new Map<string, RegisteredContext<TSubscribeContext>>();

  constructor(
    public readonly channel: string,
    private config: ChannelRouterConfig = {},
  ) {}

  // =========================================================================
  // Getters for lazy-initialized dependencies
  // =========================================================================

  getTransport(): ChannelTransport {
    if (this.config.transport) {
      return typeof this.config.transport === "function"
        ? this.config.transport()
        : this.config.transport;
    }
    const service = this.getChannelService();
    const transport = service?.getTransport?.();
    if (transport) {
      this.setTransport(transport);
      return transport;
    }
    throw ValidationError.required(`ChannelRouter[${this.channel}].transport`);
  }

  getChannelService(): ChannelService {
    const service = this.config.channelService;
    if (!service) {
      throw ValidationError.required(`ChannelRouter[${this.channel}].channelService`);
    }
    return typeof service === "function" ? service() : service;
  }

  setChannelService(service: ChannelService): void {
    this.config.channelService = service;
    // If router doesn't have transport configured, get it from the service
    if (!this.config.transport) {
      const transport = service?.getTransport?.();
      if (transport) {
        this.setTransport(transport);
      }
    }
  }

  setTransport(transport: ChannelTransport): void {
    this.config.transport = transport;
  }

  setScope(scope: ScopeDefinition): void {
    this.config.scope = scope;
  }

  setContextBuilder(contextBuilder: (data: any) => any): void {
    this.config.contextBuilder = contextBuilder;
  }

  // =========================================================================
  // Handler Registration (Fluent API)
  // =========================================================================

  /**
   * Register a handler for a specific event type.
   * Handler receives (event, context) where context is built from the request
   * via contextBuilder or passed directly to handle().
   */
  on(eventType: string, handler: ChannelEventHandler<TSubscribeContext>): this {
    this.handlers.set(eventType, handler);
    return this;
  }

  /**
   * Register a default handler for unmatched event types.
   */
  default(handler: ChannelEventHandler<TSubscribeContext>): this {
    this.defaultHandler = handler;
    return this;
  }

  /**
   * Register an error handler.
   */
  onError(handler: (error: Error, event: ChannelEvent) => void): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Handle an incoming event.
   * Called by ChannelService.handleEvent() or directly.
   * Auto-notifies registered execution contexts after handler returns.
   *
   * @param event - The channel event to handle
   * @param context - Context for the handler (required)
   * @returns Result from the handler, or undefined if no handler matched
   */
  async handle<TResult = unknown>(
    event: ChannelEvent,
    context: TSubscribeContext,
  ): Promise<TResult | undefined> {
    const handler = this.handlers.get(event.type) || this.defaultHandler;

    if (!handler) {
      return undefined;
    }

    try {
      const result = await handler(event, context);

      // Auto-notify all registered execution contexts for this scope
      this.notifyRegisteredContexts(context, event, result);

      return result as TResult;
    } catch (error) {
      if (this.errorHandler) {
        this.errorHandler(error as Error, event);
      } else {
        console.error(`ChannelRouter[${this.channel}] error handling ${event.type}:`, error);
      }
      throw error;
    }
  }

  /**
   * Build the context for the handler.
   */
  buildContext(data: any): TSubscribeContext {
    return this.config.contextBuilder?.(data) ?? (data as TSubscribeContext);
  }

  // =========================================================================
  // Context Registry - Per-execution context registration
  // =========================================================================

  /**
   * Check if value is a ScopeMapping (object with string values, not an array or function)
   */
  private isScopeMapping(value: unknown): value is ScopeMapping {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof value !== "function"
    );
  }

  /**
   * Extract scope keys from channel context based on scope config.
   * Returns array of fully qualified keys like 'prefix:value'.
   *
   * @example
   * // scope: { user: 'userId' }, ctx: { userId: 'alice' }
   * // → ['user:alice']
   *
   * // scope: [{ user: 'userId' }, { thread: 'threadId' }], ctx: { userId: 'alice', threadId: '123' }
   * // → ['user:alice', 'thread:123']
   *
   * // scope: (ctx) => `user:${ctx.userId}`, ctx: { userId: 'alice' }
   * // → ['user:alice']
   */
  private getScopeKeys(channelContext: TSubscribeContext): string[] {
    const scope = this.config.scope;
    const ctx = channelContext as Record<string, unknown>;

    if (!scope) {
      return ["default"];
    }

    // Function: (ctx) => 'user:alice' or ['user:alice', 'thread:123']
    if (typeof scope === "function") {
      const scopeFn = scope as (ctx: any) => string | string[];
      const result = scopeFn(ctx);
      return Array.isArray(result) ? result : [result];
    }

    // ScopeMapping: { user: 'userId' }
    if (this.isScopeMapping(scope)) {
      return this.extractKeysFromMapping(scope, ctx);
    }

    // ScopeMapping[]: [{ user: 'userId' }, { thread: 'threadId' }]
    if (Array.isArray(scope)) {
      const keys: string[] = [];
      for (const item of scope) {
        if (this.isScopeMapping(item)) {
          keys.push(...this.extractKeysFromMapping(item, ctx));
        }
      }
      return keys.length > 0 ? keys : ["default"];
    }

    return ["default"];
  }

  /**
   * Extract scope keys from a single ScopeMapping.
   */
  private extractKeysFromMapping(mapping: ScopeMapping, ctx: Record<string, unknown>): string[] {
    const keys: string[] = [];
    for (const [prefix, field] of Object.entries(mapping)) {
      const value = ctx[field] as string;
      if (value) {
        keys.push(`${prefix}:${value}`);
      }
    }
    return keys;
  }

  /**
   * Register an execution's context with this channel.
   * When channel events are handled, the onEvent callback is automatically invoked
   * with the event and handler result.
   *
   * @param ctx - Engine context (provides executionHandle for auto-cleanup)
   * @param channelContext - The context to register (used for scope matching)
   * @param onEvent - Callback invoked after handler returns (receives event + result)
   * @returns ChannelPublisher for publishing events
   *
   * @example
   * ```typescript
   * // In component onMount
   * const publisher = channel.registerContext(ctx, { userId }, (event, result) => {
   *   if (result?.success) com.setState('tasks', result.tasks);
   * });
   * publisher.to(userId).broadcast({ type: 'state_changed', payload });
   *
   * // In component onUnmount
   * channel.unregisterContext(ctx);
   * ```
   */
  registerContext(
    ctx: EngineContext,
    channelContext: TSubscribeContext,
    onEvent?: ContextEventCallback,
  ): ChannelPublisher {
    const executionId = ctx.executionHandle?.pid;
    if (!executionId) {
      console.warn(
        `ChannelRouter[${this.channel}]: Cannot register context without execution handle`,
      );
      return this.createPublisher(); // Return publisher anyway for API consistency
    }

    // Get all scope keys for this context (may be multiple with scope mappings)
    const scopeKeys = this.getScopeKeys(channelContext);

    // Register for each scope key
    for (const scopeKey of scopeKeys) {
      const fullKey = `${executionId}:${scopeKey}`;

      // Overwrite if already registered (same execution + scope)
      this.contextRegistry.set(fullKey, {
        executionId,
        context: channelContext,
        onEvent,
      });
    }

    // Auto-cleanup on execution end (fail-safe)
    const cleanupHandler = () => {
      this.cleanupExecution(executionId);
    };

    // Hook into execution completion/cancellation
    ctx.executionHandle?.once("completed", cleanupHandler);
    ctx.executionHandle?.once("abort", cleanupHandler);

    // Return publisher for this channel
    return this.createPublisher();
  }

  /**
   * Unregister all contexts for an execution.
   * Alternative to storing the returned function from registerContext.
   *
   * @param ctx - Engine context to unregister
   */
  unregisterContext(ctx: EngineContext): void {
    const executionId = ctx.executionHandle?.pid;
    if (!executionId) return;

    // Remove all entries for this execution
    for (const [key] of this.contextRegistry) {
      if (key.startsWith(`${executionId}:`)) {
        this.contextRegistry.delete(key);
      }
    }
  }

  /**
   * Clean up all contexts for a specific execution ID.
   * Called as a fail-safe when execution ends.
   *
   * @param executionId - The execution ID to clean up
   */
  cleanupExecution(executionId: string): void {
    for (const [key] of this.contextRegistry) {
      if (key.startsWith(`${executionId}:`)) {
        this.contextRegistry.delete(key);
      }
    }
  }

  /**
   * Extract the scope key from a registry key.
   * Registry keys are formatted as `${executionId}:${scopeKey}`.
   * We find the first colon and take everything after it as the scopeKey.
   */
  private extractScopeKeyFromRegistryKey(registryKey: string): string {
    const colonIndex = registryKey.indexOf(":");
    if (colonIndex === -1) {
      return registryKey;
    }
    return registryKey.substring(colonIndex + 1);
  }

  /**
   * Execute a callback for each registered context matching scope(s).
   * Scope keys are derived from the provided context (or explicit scopeKey).
   * Deduplicates by executionId - each execution's callback runs at most once.
   *
   * @param scopeKeyOrContext - Either explicit scope key or context to derive scope from
   * @param fn - Callback to execute for each matching context
   *
   * @example
   * ```typescript
   * // Using context (scope derived automatically, supports multiple scopes)
   * channel.forEachContext(ctx, (regCtx) => regCtx.onUpdate?.(result.notes));
   *
   * // Using explicit scope key (single key)
   * channel.forEachContext('user:alice', (regCtx) => regCtx.onUpdate?.(result.notes));
   * ```
   */
  forEachContext(
    scopeKeyOrContext: string | TSubscribeContext,
    fn: (ctx: TSubscribeContext) => void,
  ): void {
    const scopeKeys =
      typeof scopeKeyOrContext === "string"
        ? [scopeKeyOrContext]
        : this.getScopeKeys(scopeKeyOrContext);

    const processedExecutions = new Set<string>();

    for (const scopeKey of scopeKeys) {
      for (const [key, { executionId, context }] of this.contextRegistry) {
        // Extract scope key from registry key and compare exactly
        // This prevents 'malicious_user:alice' from matching 'user:alice'
        const registeredScopeKey = this.extractScopeKeyFromRegistryKey(key);
        if (registeredScopeKey === scopeKey && !processedExecutions.has(executionId)) {
          processedExecutions.add(executionId);
          try {
            fn(context);
          } catch (error) {
            console.error(
              `ChannelRouter[${this.channel}]: Error in forEachContext callback:`,
              error,
            );
          }
        }
      }
    }
  }

  /**
   * Notify all registered contexts for matching scopes with an event and result.
   * Called automatically by handle() after handler returns.
   * Deduplicates by executionId - each execution's callback runs at most once.
   *
   * @param context - Context to derive scope from
   * @param event - The channel event
   * @param result - The handler's result
   */
  private notifyRegisteredContexts(
    context: TSubscribeContext,
    event: ChannelEvent,
    result: unknown,
  ): void {
    const scopeKeys = this.getScopeKeys(context);
    const notifiedExecutions = new Set<string>();

    for (const scopeKey of scopeKeys) {
      for (const [key, { executionId, onEvent }] of this.contextRegistry) {
        // Extract scope key from registry key and compare exactly
        // This prevents 'malicious_user:alice' from matching 'user:alice'
        const registeredScopeKey = this.extractScopeKeyFromRegistryKey(key);
        if (registeredScopeKey === scopeKey && !notifiedExecutions.has(executionId) && onEvent) {
          notifiedExecutions.add(executionId);
          try {
            onEvent(event, result);
          } catch (error) {
            console.error(`ChannelRouter[${this.channel}]: Error in onEvent callback:`, error);
          }
        }
      }
    }
  }

  /**
   * Get the number of registered contexts (for debugging/monitoring).
   */
  getRegisteredContextCount(): number {
    return this.contextRegistry.size;
  }

  // =========================================================================
  // Publishing Methods
  // =========================================================================

  /**
   * Resolve a value or getter function.
   */
  private resolve<T>(valueOrGetter: ValueOrGetter<T>): T {
    return typeof valueOrGetter === "function" ? (valueOrGetter as () => T)() : valueOrGetter;
  }

  /**
   * Get the scope prefix for a given scope key.
   * If scopeKey is provided, uses that key from the mapping.
   * Otherwise uses the first key from the mapping.
   *
   * Note: Function scopes are not supported for publishing via .scope()/.to() -
   * use mapping syntax instead: { user: 'userId' }
   */
  private getScopePrefix(scopeKey?: string): string | undefined {
    const scope = this.config.scope;
    if (!scope) return undefined;

    // Function scope - can't select by key for publishing
    // (functions are for context matching, not room prefix selection)
    if (typeof scope === "function") {
      return undefined;
    }

    // Get the mapping (flatten if array)
    const mapping = Array.isArray(scope)
      ? scope.reduce((acc, m) => ({ ...acc, ...m }), {} as ScopeMapping)
      : scope;

    // If scopeKey provided, use it; otherwise use first key
    if (scopeKey) {
      return scopeKey in mapping ? scopeKey : undefined;
    }

    const keys = Object.keys(mapping);
    return keys.length > 0 ? keys[0] : undefined;
  }

  /**
   * Create a scoped publisher (has scope prefix set, needs .to(id)).
   */
  private createScopedPublisherForKey(scopePrefix: string): ScopedPublisher {
    return {
      to: (idGetter: ValueOrGetter<string>) => {
        return this.createBoundPublisherForPrefix(scopePrefix, idGetter);
      },
    };
  }

  /**
   * Create a bound publisher for a specific scope prefix.
   */
  private createBoundPublisherForPrefix(
    scopePrefix: string,
    idGetter: ValueOrGetter<string>,
  ): BoundPublisher {
    return {
      send: async (event) => {
        const id = this.resolve(idGetter);
        await this.sendInternalWithPrefix(scopePrefix, id, event);
      },
      broadcast: async (event, options?) => {
        const id = this.resolve(idGetter);
        await this.sendInternalWithPrefix(scopePrefix, id, event, {
          excludeSender: true,
          sourceConnectionId: options?.sourceConnectionId,
        });
      },
    };
  }

  /**
   * Internal send with explicit scope prefix and id.
   */
  private async sendInternalWithPrefix(
    scopePrefix: string,
    id: string,
    event: { type: string; payload: unknown },
    options?: { excludeSender?: boolean; sourceConnectionId?: string },
  ): Promise<void> {
    const transport = this.getTransport();
    const room = `${scopePrefix}:${id}`;

    const sourceConnectionId =
      options?.sourceConnectionId ??
      ((Context.tryGet() as EngineContext | undefined)?.metadata?.["sessionId"] as
        | string
        | undefined);

    await transport.send({
      channel: this.channel!,
      type: event.type,
      payload: event.payload,
      target: {
        rooms: [room],
        excludeSender: options?.excludeSender,
      },
      metadata: {
        timestamp: Date.now(),
        source: `ChannelRouter:${this.channel}`,
        sourceConnectionId,
      },
    });
  }

  /**
   * Create a publisher interface for this channel.
   */
  private createPublisher(): ChannelPublisher {
    return {
      scope: (scopeKey: string) => {
        const prefix = this.getScopePrefix(scopeKey);
        if (!prefix) {
          throw new NotFoundError(
            "scope",
            scopeKey,
            `ChannelRouter[${this.channel}]: Unknown scope key`,
          );
        }
        return this.createScopedPublisherForKey(prefix);
      },
      to: (idGetter: ValueOrGetter<string>) => {
        const prefix = this.getScopePrefix();
        if (!prefix) {
          throw ValidationError.required(`ChannelRouter[${this.channel}].scope`);
        }
        return this.createBoundPublisherForPrefix(prefix, idGetter);
      },
    };
  }

  /**
   * Get a publisher without subscribing (for services that only publish).
   */
  publisher(): ChannelPublisher {
    return this.createPublisher();
  }
}

/**
 * Factory function to create a ChannelRouter with common defaults.
 */
export function createChannelRouter(
  channel: string,
  config: ChannelRouterConfig = {},
): ChannelRouter {
  return new ChannelRouter(channel, config);
}
