import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { type ChannelServiceInterface } from "./channel";
import type { ProcedureGraph } from "./procedure-graph";
import type { ProcedureNode } from "./procedure-graph";
import { ContextError } from "@agentick/shared";
import type { Middleware } from "./procedure";

/**
 * User information associated with the current execution context.
 *
 * This is typically populated from authentication/authorization systems
 * and flows through all operations via the `KernelContext`.
 *
 * @example
 * ```typescript
 * const ctx = Context.create({
 *   user: {
 *     id: 'user-123',
 *     tenantId: 'tenant-abc',
 *     roles: ['admin', 'editor'],
 *     email: 'user@example.com', // Custom fields allowed
 *   }
 * });
 * ```
 *
 * @see {@link KernelContext.user} - Where user context is stored
 */
export interface UserContext {
  /** Unique identifier for the user */
  id: string;
  /** Multi-tenant organization identifier */
  tenantId?: string;
  /** User's roles for authorization */
  roles?: string[];
  /** Additional user properties (extensible) */
  [key: string]: any;
}

/**
 * Event emitted during procedure execution.
 *
 * Events are emitted to both the global request bus (`ctx.events`)
 * and the operation handle (`ctx.executionHandle`) if present.
 *
 * @example
 * ```typescript
 * ctx.events.on('stream:chunk', (event: ExecutionEvent) => {
 *   console.log(`[${event.source}] ${event.type}:`, event.payload);
 * });
 *
 * // Listen to all events
 * ctx.events.on('*', (event: ExecutionEvent) => {
 *   console.log(`Event: ${event.type}`);
 * });
 * ```
 *
 * @see {@link Context.emit} - Emit events to the current context
 */
export interface ExecutionEvent {
  /** Event type (e.g., 'stream:chunk', 'procedure:error') */
  type: string;
  /** Event payload data */
  payload: any;
  /** Unix timestamp when the event occurred */
  timestamp: number;
  /** Source of the event (e.g., 'agent:sales', 'model:openai') */
  source: string;
  /** Trace ID for correlation (distributed tracing) */
  traceId: string;
  /** Request ID for this execution context */
  requestId?: string;
  /** Execution ID from context (auto-populated if available) */
  executionId?: string;
  /** Parent execution ID for nested executions (fork, spawn, component_tool) */
  parentExecutionId?: string;
  /** Procedure ID from context (auto-populated if available) */
  procedureId?: string;
  /** Current tick number if in a tick context */
  tick?: number;
  // ─────────────────────────────────────────────────────────────────────────────
  // User Context (for multi-tenant telemetry)
  // ─────────────────────────────────────────────────────────────────────────────
  /** User ID from context (for attribution and multi-tenant filtering) */
  userId?: string;
  /** Tenant ID from context (for multi-tenant dashboards) */
  tenantId?: string;
}

/**
 * Extensible metadata storage within the context.
 *
 * Use this to store application-specific data that should flow
 * through the execution context.
 *
 * @example
 * ```typescript
 * const ctx = Context.create({
 *   metadata: {
 *     conversationId: 'conv-123',
 *     feature_flags: { beta: true },
 *   }
 * });
 *
 * // Access later
 * const convId = Context.get().metadata.conversationId;
 * ```
 */
export interface ContextMetadata extends Record<string, any> {}

/**
 * Metrics accumulated during procedure execution.
 *
 * Metrics are automatically propagated from child procedures to parents
 * when execution completes.
 *
 * @example
 * ```typescript
 * // In a procedure
 * addMetric(ctx, 'tokens.input', 100);
 * addMetric(ctx, 'api_calls', 1);
 *
 * // After execution, parent has accumulated metrics
 * const totalTokens = ctx.metrics['tokens.input'];
 * ```
 *
 * @see {@link addMetric} - Accumulate a metric value
 * @see {@link getUsageMetrics} - Get token usage metrics
 */
export interface ContextMetrics extends Record<string, any> {}

/**
 * Execution context that flows through all async operations via AsyncLocalStorage.
 *
 * The `KernelContext` contains all state needed during execution:
 * - Identity and tracing (requestId, traceId, user)
 * - Event buses (events, executionHandle)
 * - Cancellation (signal)
 * - Communication (channels)
 * - Execution tracking (procedureGraph, procedurePid, origin)
 * - Extensible storage (metadata, metrics)
 *
 * Access the current context with `Context.get()` from anywhere in your code -
 * no need to pass it explicitly through function calls.
 *
 * @example Creating and running with context
 * ```typescript
 * const ctx = Context.create({
 *   user: { id: 'user-1' },
 *   metadata: { conversationId: 'conv-123' }
 * });
 *
 * await Context.run(ctx, async () => {
 *   // Context is available here and in all async calls
 *   const current = Context.get();
 *   console.log(current.user?.id); // 'user-1'
 * });
 * ```
 *
 * @example Extending for your application
 * ```typescript
 * interface AppContext extends KernelContext {
 *   customHandle?: MyCustomHandle;
 *   appMetadata: AppSpecificMetadata;
 * }
 * ```
 *
 * @see {@link Context} - Static methods to create/access context
 * @see {@link UserContext} - User information structure
 */
export interface KernelContext {
  /** Unique identifier for this request/execution */
  requestId: string;
  /** Correlation ID for distributed tracing */
  traceId: string;
  /** User information (from auth) */
  user?: UserContext;
  /** Application-specific metadata */
  metadata: ContextMetadata;
  /** Accumulated execution metrics */
  metrics: ContextMetrics;
  /** Global request event bus for subscribing to all events */
  events: EventEmitter;
  /** Abort signal for cooperative cancellation */
  signal?: AbortSignal;
  /** Operation-specific event emitter (from `.withHandle()`) */
  executionHandle?: EventEmitter;
  /**
   * Channel service for bidirectional communication (optional).
   * Injected by Engine when channels are configured.
   * Tools and components can access channels via this service.
   */
  channels?: ChannelServiceInterface;
  /**
   * Procedure graph for tracking procedure execution hierarchy.
   * Automatically initialized when first procedure is executed.
   */
  procedureGraph?: ProcedureGraph;
  /**
   * Current procedure PID (for tracking nested procedures).
   */
  procedurePid?: string;
  /** Current procedure node in the graph */
  procedureNode?: ProcedureNode;
  /**
   * Origin procedure node - the root procedure that initiated this execution chain.
   * Undefined for the root procedure itself (since it IS the origin).
   * Set automatically by ExecutionTracker when procedures are executed.
   */
  origin?: ProcedureNode;

  // ─────────────────────────────────────────────────────────────────────────────
  // Execution Context (Phase 3)
  // Executions are "sign posts" - annotations on the procedure graph that mark
  // significant boundaries (engine entry points, component tools, fork/spawn).
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Current execution ID. Set when entering an execution boundary.
   * All procedures within this execution share this ID.
   */
  executionId?: string;

  /**
   * Type of execution at this boundary (e.g., 'engine', 'model', 'component_tool', 'fork', 'spawn').
   * Only meaningful at execution boundaries.
   */
  executionType?: string;

  /**
   * Parent execution ID for nested executions (e.g., component_tool called from engine).
   * Enables DevTools to show execution hierarchy.
   */
  parentExecutionId?: string;

  /**
   * Session ID (set by session's runWithContext).
   * Available during all session execution — tool calls, prepareModelInput, etc.
   */
  sessionId?: string;

  /**
   * Current tick number (set by engine during tick loop).
   * Enables events to include tick context for correlation.
   */
  tick?: number;

  /**
   * Middleware registry for procedure execution.
   * Procedures read this at execution time to get instance-level middleware.
   * Typically set by createApp() from the Agentick instance.
   */
  middleware?: {
    getMiddlewareFor(procedureName: string): Middleware[];
  };

  /**
   * Type brand for context detection
   */
  [KERNEL_CONTEXT_SYMBOL]?: boolean;
}

const storage = new AsyncLocalStorage<KernelContext>();

/**
 * Global event subscribers that receive ALL context events across all contexts.
 * Use `Context.subscribeGlobal()` to register a subscriber.
 */
const globalSubscribers = new Set<(event: ExecutionEvent, ctx: KernelContext) => void>();

/**
 * Static class for managing execution context via AsyncLocalStorage.
 *
 * Context flows automatically through all async operations without explicit passing.
 * Use `Context.run()` to establish context, and `Context.get()` to access it.
 *
 * @example Basic usage
 * ```typescript
 * // Create and run with context
 * const ctx = Context.create({ user: { id: 'user-1' } });
 * await Context.run(ctx, async () => {
 *   const current = Context.get();
 *   console.log(current.user?.id); // 'user-1'
 *
 *   // Context flows to nested calls
 *   await someAsyncFunction(); // Can access Context.get() inside
 * });
 * ```
 *
 * @example Parallel execution with child contexts
 * ```typescript
 * // Each parallel task gets its own context to avoid races
 * const [a, b] = await Promise.all([
 *   Context.fork({ procedurePid: 'task-1' }, () => doTask1()),
 *   Context.fork({ procedurePid: 'task-2' }, () => doTask2()),
 * ]);
 * ```
 *
 * @example Emitting events
 * ```typescript
 * // Events go to both global bus and operation handle
 * Context.emit('progress', { percent: 50 }, 'my-tool');
 * ```
 *
 * @see {@link KernelContext} - The context interface
 * @see {@link context} - Brand an object as context for procedure detection
 */
export class Context {
  /**
   * Creates a new root context with default values.
   *
   * @param overrides - Partial context to merge with defaults
   * @returns A new KernelContext
   *
   * @example
   * ```typescript
   * const ctx = Context.create({
   *   user: { id: 'user-1' },
   *   metadata: { feature: 'chat' }
   * });
   * ```
   */
  static create(overrides: Partial<Omit<KernelContext, "events">> = {}): KernelContext {
    return this.brand({
      requestId: overrides.requestId ?? crypto.randomUUID(),
      traceId: overrides.traceId ?? crypto.randomUUID(),
      metadata: overrides.metadata ?? {},
      metrics: {},
      events: new EventEmitter(),
      user: overrides.user,
      signal: overrides.signal,
      executionHandle: overrides.executionHandle,
      // Agentick middleware registry (for context-based middleware resolution)
      middleware: overrides.middleware,
      // Session context
      sessionId: overrides.sessionId,
      // Execution context fields (Phase 3)
      executionId: overrides.executionId,
      executionType: overrides.executionType,
      parentExecutionId: overrides.parentExecutionId,
    });
  }

  static brand(ctx: Partial<KernelContext>): KernelContext {
    if (!isKernelContext(ctx)) {
      return { ...(ctx as any), [KERNEL_CONTEXT_SYMBOL]: true };
    }
    return ctx as KernelContext;
  }

  /**
   * Runs a function within the given context.
   * All async operations within `fn` will have access to this context.
   *
   * @param context - The context to run within
   * @param fn - Async function to execute
   * @returns The result of the function
   */
  static run<T>(ctx: Partial<KernelContext>, fn: () => Promise<T>): Promise<T> {
    return storage.run((isKernelContext(ctx) ? ctx : Context.create(ctx)) as KernelContext, fn);
  }

  /**
   * Creates a child context that inherits from the current context (or creates a new root).
   * The child context is a shallow copy - objects like `events`, `procedureGraph`, and `channels`
   * are shared with the parent (intentionally, for coordination).
   *
   * Scalar values like `procedurePid`, `procedureNode`, and `origin` can be safely
   * overridden in the child without affecting the parent.
   *
   * @param overrides - Properties to override in the child context
   * @returns A new context object inheriting from the current context
   *
   * @example
   * ```typescript
   * // Create child context with new procedure ID
   * const childCtx = Context.child({ procedurePid: 'new-pid' });
   * await Context.run(childCtx, async () => {
   *   // This context has its own procedurePid but shares events, graph, etc.
   * });
   * ```
   */
  static child(overrides: Partial<KernelContext> = {}): KernelContext {
    const parent = Context.tryGet();
    if (!parent) {
      // No parent context - create a new root context
      return Context.create(overrides);
    }
    // Create shallow copy of parent, then apply overrides
    return this.brand({
      ...parent,
      ...overrides,
    });
  }

  /**
   * Creates a child context and runs a function within it.
   * Convenience method combining `child()` and `run()`.
   *
   * This is the safe way to run parallel procedures - each gets its own
   * context object so mutations don't race.
   *
   * @param overrides - Properties to override in the child context
   * @param fn - Function to run within the child context
   * @returns The result of the function
   *
   * @example
   * ```typescript
   * // Run parallel procedures safely
   * const [result1, result2] = await Promise.all([
   *   Context.fork({ procedurePid: 'proc-1' }, async () => doWork1()),
   *   Context.fork({ procedurePid: 'proc-2' }, async () => doWork2()),
   * ]);
   * ```
   */
  static fork<T>(overrides: Partial<KernelContext>, fn: () => Promise<T>): Promise<T> {
    const childCtx = Context.child(overrides);
    return Context.run(childCtx, fn);
  }

  /**
   * Gets the current context. Throws if not found.
   */
  static get(): KernelContext {
    const store = storage.getStore();
    if (!store) {
      throw ContextError.notFound();
    }
    return store;
  }

  /**
   * Gets the current context or returns undefined if not found.
   */
  static tryGet(): KernelContext | undefined {
    return storage.getStore();
  }

  /**
   * Set the current tick number in the context.
   * Called by the engine at the start of each tick.
   */
  static setTick(tick: number): void {
    const ctx = this.tryGet();
    if (ctx) {
      ctx.tick = tick;
    }
  }

  /**
   * Helper to emit an event on the current context.
   * Events are broadcast to:
   * 1. The context's local event bus (ctx.events)
   * 2. The operation handle (ctx.executionHandle) if present
   * 3. All global subscribers registered via subscribeGlobal()
   */
  static emit(type: string, payload: any, source: string = "system"): void {
    const ctx = this.tryGet();
    if (ctx) {
      const event: ExecutionEvent = {
        type,
        payload,
        timestamp: Date.now(),
        source,
        // Correlation IDs for distributed tracing
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        // Execution context (for execution tree building)
        executionId: ctx.executionId,
        parentExecutionId: ctx.parentExecutionId,
        procedureId: ctx.procedurePid,
        tick: ctx.tick,
        // User context (for multi-tenant telemetry)
        userId: ctx.user?.id,
        tenantId: ctx.user?.tenantId,
      };

      // 1. Emit to the Global Request Bus
      ctx.events.emit(type, event);
      ctx.events.emit("*", event);

      // 2. Emit to the Operation Handle (if exists and is an EventEmitter)
      if (ctx.executionHandle) {
        ctx.executionHandle.emit?.(type, event);
        ctx.executionHandle.emit?.("*", event);
      }

      // 3. Emit to global subscribers (for DevTools, telemetry, etc.)
      for (const subscriber of globalSubscribers) {
        try {
          subscriber(event, ctx);
        } catch {
          // Silently ignore subscriber errors - don't break execution
        }
      }
    }
  }

  /**
   * Subscribe to ALL context events globally.
   * This is useful for observability tools like DevTools that need to see
   * all procedure:start/end/error events across all contexts.
   *
   * @param handler - Callback that receives every event with its context
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = Context.subscribeGlobal((event, ctx) => {
   *   if (event.type === 'procedure:start') {
   *     console.log(`Procedure ${event.payload.name} started`);
   *   }
   * });
   *
   * // Later, to stop receiving events:
   * unsubscribe();
   * ```
   */
  static subscribeGlobal(handler: (event: ExecutionEvent, ctx: KernelContext) => void): () => void {
    globalSubscribers.add(handler);
    return () => {
      globalSubscribers.delete(handler);
    };
  }

  /**
   * Check if there are any global subscribers.
   * Useful for conditional event emission to avoid overhead when no one is listening.
   */
  static hasGlobalSubscribers(): boolean {
    return globalSubscribers.size > 0;
  }
}

export class ContextProvider {
  withContext<T>(context: KernelContext, fn: () => Promise<T>): Promise<T> {
    return Context.run(Context.create(context), async () => await fn());
  }
}

/**
 * Symbol used to brand context objects for deterministic detection.
 * This allows procedures to distinguish context from regular arguments.
 */
export const KERNEL_CONTEXT_SYMBOL = Symbol.for("@agentick/kernel.context");

/**
 * Brand a context object with a Symbol for deterministic detection.
 * This allows procedures to deterministically identify context vs regular args.
 *
 * @example
 * ```typescript
 * await proc(input, agent, context({ traceId: "123" }));
 * ```
 */
export function context(ctx: Partial<KernelContext>): Partial<KernelContext> {
  return Context.brand(ctx);
}

/**
 * Check if an object is a branded context (deterministic check via Symbol).
 * This is 100% reliable - no heuristics needed.
 */
export function isKernelContext(obj: any): obj is Partial<KernelContext> {
  return obj != null && typeof obj === "object" && KERNEL_CONTEXT_SYMBOL in obj;
}
