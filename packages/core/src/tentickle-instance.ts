/**
 * Tentickle Configuration Instance
 *
 * `Tentickle` is the default global instance. Users interact with instances, never the class directly.
 *
 * ```typescript
 * import { Tentickle, createApp } from 'tentickle';
 *
 * // Configure global instance
 * Tentickle.use('*', loggingMiddleware);
 * Tentickle.use('tool:*', authMiddleware);
 *
 * // createApp uses Tentickle by default
 * const app = createApp(MyAgent, { model });
 *
 * // Create a scoped instance (inherits from Tentickle)
 * const scoped = Tentickle.create();
 * scoped.use('model:generate', rateLimitMiddleware);
 * const scopedApp = scoped.createApp(MyAgent, { model });
 *
 * // Create isolated instance (no inheritance)
 * const isolated = Tentickle.create({ inheritDefaults: false });
 * ```
 *
 * @module tentickle/@tentickle/instance
 */

import { type Middleware, type TelemetryProvider, createProcedure, type Procedure } from "./core";
import type {
  App,
  AppInput,
  AppOptions,
  SessionOptions,
  Session,
  SessionExecutionHandle,
  ComponentFunction,
  ExecutionOptions,
  SendInput,
} from "./app/types";
import { SessionImpl } from "./app/session";

/**
 * Key for middleware registration.
 * - `'*'` - matches all procedures
 * - `'tool:*'` - matches all tool procedures
 * - `'tool:run'` - matches specific procedure
 * - `'model:generate'` - matches specific procedure
 */
export type MiddlewareKey = string;

/**
 * Options for creating an TentickleInstance.
 */
export interface TentickleInstanceCreateOptions {
  /** Telemetry provider for tracing and metrics */
  telemetryProvider?: TelemetryProvider;
  /**
   * Whether to inherit middleware from the parent instance.
   * @default true
   */
  inheritDefaults?: boolean;
}

/**
 * Interface for middleware resolution.
 * This is what gets passed to context for procedures to read at execution time.
 */
export interface MiddlewareRegistry {
  /**
   * Get middleware matching a procedure name.
   * Matches in order: '*', category wildcard ('tool:*'), exact name
   */
  getMiddlewareFor(procedureName: string): Middleware[];
}

// ============================================================================
// Session Registry (App-managed sessions with hibernation support)
// ============================================================================

import type { SessionStore, SessionSnapshot, SessionManagementOptions } from "./app/types";
import { createSessionStore } from "./app/sqlite-session-store";

interface SessionRegistryOptions<P> {
  // Legacy options (deprecated)
  sessionTTL?: number;
  maxSessions?: number;

  // New session management options
  sessions?: SessionManagementOptions;

  // Callbacks
  onSessionClose?: (sessionId: string) => void;
  onBeforeHibernate?: (
    session: SessionImpl<P>,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;
  onAfterHibernate?: (sessionId: string, snapshot: SessionSnapshot) => void | Promise<void>;
  onBeforeHydrate?: (
    sessionId: string,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;
  onAfterHydrate?: (session: SessionImpl<P>, snapshot: SessionSnapshot) => void | Promise<void>;
}

class SessionRegistry<P> {
  private sessions = new Map<string, SessionImpl<P>>();
  private lastActivity = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  // Resolved options
  private readonly store?: SessionStore;
  private readonly idleTimeout: number;
  private readonly maxActive: number;
  private readonly autoHibernate: boolean;

  constructor(private readonly options: SessionRegistryOptions<P>) {
    // Resolve options with backwards compatibility
    const sessionsConfig = options.sessions ?? {};
    // Resolve store configuration (string path, config object, or SessionStore instance)
    this.store = createSessionStore(sessionsConfig.store);
    this.idleTimeout = sessionsConfig.idleTimeout ?? options.sessionTTL ?? 0;
    this.maxActive = sessionsConfig.maxActive ?? options.maxSessions ?? 0;
    this.autoHibernate = sessionsConfig.autoHibernate ?? !!this.store;

    // Start sweep timer if we have an idle timeout
    if (this.idleTimeout > 0) {
      const interval = Math.max(1000, Math.min(this.idleTimeout, 30000));
      this.sweepTimer = setInterval(() => this.sweep(), interval);
    }
  }

  get(sessionId: string): SessionImpl<P> | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.touch(sessionId);
    }
    return session;
  }

  /**
   * Try to get a session, hydrating from store if necessary.
   * Returns undefined if session doesn't exist anywhere.
   */
  async getOrHydrate(
    sessionId: string,
    createSession: (snapshot: SessionSnapshot) => SessionImpl<P>,
  ): Promise<SessionImpl<P> | undefined> {
    // Check in-memory first
    const existing = this.get(sessionId);
    if (existing) {
      return existing;
    }

    // Try to hydrate from store
    if (!this.store) {
      return undefined;
    }

    const snapshot = await this.store.load(sessionId);
    if (!snapshot) {
      return undefined;
    }

    // Call onBeforeHydrate hook
    if (this.options.onBeforeHydrate) {
      const result = await this.options.onBeforeHydrate(sessionId, snapshot);
      if (result === false) {
        return undefined; // Hydration cancelled
      }
      if (result && typeof result === "object" && "version" in result) {
        // Use modified snapshot
        const session = createSession(result as SessionSnapshot);
        this.register(session.id, session);

        // Call onAfterHydrate
        await this.options.onAfterHydrate?.(session, result as SessionSnapshot);

        // Delete from store since it's now in memory
        await this.store.delete(sessionId);

        return session;
      }
    }

    // Create session from snapshot
    const session = createSession(snapshot);
    this.register(session.id, session);

    // Call onAfterHydrate
    await this.options.onAfterHydrate?.(session, snapshot);

    // Delete from store since it's now in memory
    await this.store.delete(sessionId);

    return session;
  }

  register(sessionId: string, session: SessionImpl<P>): void {
    this.sessions.set(sessionId, session);
    this.touch(sessionId);
    this.enforceMaxActive();
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async isHibernated(sessionId: string): Promise<boolean> {
    if (!this.store) {
      return false;
    }
    if (this.store.has) {
      return this.store.has(sessionId);
    }
    // Fallback: try to load
    const snapshot = await this.store.load(sessionId);
    return snapshot !== null;
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  async listHibernated(): Promise<string[]> {
    if (!this.store?.list) {
      return [];
    }
    return this.store.list();
  }

  /**
   * Hibernate a session (save to store and remove from memory).
   * Returns the snapshot if successful, null if cancelled or no store.
   */
  async hibernate(sessionId: string): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (!this.store) {
      // No store configured - just close the session
      this.remove(sessionId, true);
      return null;
    }

    // Get snapshot
    const snapshot = session.snapshot();

    // Call onBeforeHibernate hook
    if (this.options.onBeforeHibernate) {
      const result = await this.options.onBeforeHibernate(session, snapshot);
      if (result === false) {
        return null; // Hibernation cancelled
      }
      if (result && typeof result === "object" && "version" in result) {
        // Use modified snapshot
        await this.store.save(sessionId, result as SessionSnapshot);
        this.remove(sessionId, true);
        await this.options.onAfterHibernate?.(sessionId, result as SessionSnapshot);
        return result as SessionSnapshot;
      }
    }

    // Save to store
    await this.store.save(sessionId, snapshot);

    // Remove from memory (close session)
    this.remove(sessionId, true);

    // Call onAfterHibernate
    await this.options.onAfterHibernate?.(sessionId, snapshot);

    return snapshot;
  }

  remove(sessionId: string, closeSession = true): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    this.lastActivity.delete(sessionId);

    if (closeSession) {
      session.close();
    }

    this.options.onSessionClose?.(sessionId);
  }

  /**
   * Permanently delete a session from both memory and store.
   */
  async delete(sessionId: string): Promise<void> {
    this.remove(sessionId, true);
    if (this.store) {
      await this.store.delete(sessionId);
    }
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const sessionId of this.sessions.keys()) {
      this.remove(sessionId, true);
    }
  }

  private touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.lastActivity.set(sessionId, Date.now());
    // Maintain LRU order by re-inserting
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  markActive(sessionId: string): void {
    this.touch(sessionId);
  }

  private async sweep(): Promise<void> {
    if (this.idleTimeout <= 0) return;

    const now = Date.now();
    const toHibernate: string[] = [];

    for (const [sessionId, last] of this.lastActivity.entries()) {
      if (now - last >= this.idleTimeout) {
        toHibernate.push(sessionId);
      }
    }

    // Hibernate idle sessions
    for (const sessionId of toHibernate) {
      if (this.autoHibernate && this.store) {
        await this.hibernate(sessionId);
      } else {
        this.remove(sessionId, true);
      }
    }
  }

  private async enforceMaxActive(): Promise<void> {
    if (this.maxActive <= 0) return;

    while (this.sessions.size > this.maxActive) {
      const oldestId = this.sessions.keys().next().value as string | undefined;
      if (!oldestId) break;

      if (this.autoHibernate && this.store) {
        await this.hibernate(oldestId);
      } else {
        this.remove(oldestId, true);
      }
    }
  }
}

// ============================================================================
// App Implementation
// ============================================================================

class AppImpl<P extends Record<string, unknown>> implements App<P> {
  readonly run: Procedure<(input: AppInput<P>) => SessionExecutionHandle, true>;

  private readonly registry: SessionRegistry<P>;
  private readonly sessionCreateHandlers = new Set<(session: Session<P>) => void>();
  private readonly sessionCloseHandlers = new Set<(sessionId: string) => void>();

  constructor(
    private readonly Component: ComponentFunction<P>,
    private readonly options: AppOptions,
  ) {
    this.registry = new SessionRegistry<P>({
      // Legacy options
      sessionTTL: options.sessionTTL,
      maxSessions: options.maxSessions,
      // New session management options
      sessions: options.sessions,
      // Callbacks
      onSessionClose: (sessionId) => {
        this.options.onSessionClose?.(sessionId);
        for (const handler of this.sessionCloseHandlers) {
          handler(sessionId);
        }
      },
      onBeforeHibernate: options.onBeforeHibernate as any,
      onAfterHibernate: options.onAfterHibernate,
      onBeforeHydrate: options.onBeforeHydrate,
      onAfterHydrate: options.onAfterHydrate as any,
    });

    this.run = createProcedure(
      {
        name: "app:run",
        handleFactory: false,
      },
      (input: AppInput<P>): SessionExecutionHandle => {
        const { props = {} as P, messages = [], history = [], options: runOpts = {} } = input;

        const sessionOptions: SessionOptions = {
          ...runOpts,
          initialTimeline: history.length > 0 ? history : undefined,
          devTools: runOpts.devTools ?? this.options.devTools,
        };

        const executionOptions: ExecutionOptions = {
          maxTicks: runOpts.maxTicks,
          signal: runOpts.signal,
        };

        const session = this.createSession(undefined, sessionOptions);

        for (const message of messages) {
          session.queue.exec(message);
        }

        const handle = session.tick(props, executionOptions);

        handle.result
          .finally(() => session.close())
          .catch(() => {
            // Prevent unhandled rejection - errors are captured in handle
          });

        return handle;
      },
    );
  }

  send(
    input: SendInput<P>,
    options?: { sessionId?: string } & ExecutionOptions,
  ): SessionExecutionHandle {
    const sessionId = options?.sessionId;
    const executionOptions: ExecutionOptions = {
      maxTicks: options?.maxTicks,
      signal: options?.signal,
    };

    if (!sessionId) {
      const session = this.createSession(undefined, {});
      const handle = session.send(input, executionOptions);
      handle.result
        .finally(() => session.close())
        .catch(() => {
          // Prevent unhandled rejection - errors are captured in handle
        });
      return handle;
    }

    const session = this.session(sessionId);
    const maybeModified = this.options.onBeforeSend?.(session, input) ?? input;
    const handle = session.send(maybeModified, executionOptions);
    handle.result
      .then((result) => {
        this.options.onAfterSend?.(session, result);
      })
      .catch(() => {
        // Errors are already surfaced via lifecycle callbacks
      });
    return handle;
  }

  session(idOrOptions?: string | SessionOptions): Session<P> {
    // Parse arguments: string is ID, object is options
    let sessionId: string | undefined;
    let options: SessionOptions = {};

    if (typeof idOrOptions === "string") {
      sessionId = idOrOptions;
    } else if (idOrOptions !== undefined) {
      options = idOrOptions;
      sessionId = options.sessionId;
    }

    // If we have an ID, try to get existing session first
    if (sessionId) {
      const existing = this.registry.get(sessionId);
      if (existing) return existing;
    }

    // Create new session (ID will be generated if undefined)
    return this.createSession(sessionId, options);
  }

  async close(sessionId: string): Promise<void> {
    this.registry.remove(sessionId, true);
  }

  get sessions(): readonly string[] {
    return this.registry.list();
  }

  has(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  async isHibernated(sessionId: string): Promise<boolean> {
    return this.registry.isHibernated(sessionId);
  }

  async hibernate(sessionId: string): Promise<SessionSnapshot | null> {
    return this.registry.hibernate(sessionId);
  }

  async hibernatedSessions(): Promise<string[]> {
    return this.registry.listHibernated();
  }

  onSessionCreate(handler: (session: Session<P>) => void): () => void {
    this.sessionCreateHandlers.add(handler);
    return () => {
      this.sessionCreateHandlers.delete(handler);
    };
  }

  onSessionClose(handler: (sessionId: string) => void): () => void {
    this.sessionCloseHandlers.add(handler);
    return () => {
      this.sessionCloseHandlers.delete(handler);
    };
  }

  private createSession(sessionId: string | undefined, options: SessionOptions): SessionImpl<P> {
    const sessionOptions: SessionOptions = {
      ...options,
      sessionId,
      devTools: options.devTools ?? this.options.devTools,
    };
    const session = new SessionImpl(this.Component, this.options, sessionOptions);

    // Set hibernate callback so session.hibernate() delegates to the registry
    session.setHibernateCallback(() => this.registry.hibernate(session.id));

    this.registry.register(session.id, session);

    session.on("event", () => {
      this.registry.markActive(session.id);
    });

    session.once("close", () => {
      this.registry.remove(session.id, false);
    });

    this.options.onSessionCreate?.(session);
    for (const handler of this.sessionCreateHandlers) {
      handler(session);
    }

    return session;
  }
}

/**
 * Handler type for the run procedure.
 * Generic P is the props type for the component.
 */
type RunHandler = <P extends Record<string, unknown>>(
  element: { type: ComponentFunction<P>; props: P; key: string | number | null },
  input?: RunInput<P>,
) => SessionExecutionHandle;

/**
 * Tentickle configuration instance.
 *
 * Users interact with instances, never the class directly.
 * `Tentickle` is the default global instance.
 */
export class TentickleInstance implements MiddlewareRegistry {
  private middlewareRegistry = new Map<MiddlewareKey, Middleware[]>();
  private _telemetryProvider?: TelemetryProvider;

  /**
   * One-shot execution of a JSX component.
   *
   * This is a procedure with handleFactory: false (pass-through).
   * Returns SessionExecutionHandle which is both PromiseLike and AsyncIterable:
   * - `await run(...)` → SendResult
   * - `for await (const event of run(...))` → StreamEvent
   *
   * @example Await result
   * ```typescript
   * const result = await Tentickle.run(
   *   <MyAgent />,
   *   { messages: [{ role: "user", content: [...] }], model }
   * );
   * ```
   *
   * @example Stream events
   * ```typescript
   * for await (const event of Tentickle.run(<MyAgent />, { messages, model })) {
   *   if (event.type === 'content_delta') {
   *     process.stdout.write(event.delta);
   *   }
   * }
   * ```
   *
   * @example Add middleware to run
   * ```typescript
   * const loggedRun = Tentickle.run.use(loggingMiddleware);
   * const result = await loggedRun(<MyAgent />, { messages, model });
   * ```
   */
  readonly run: Procedure<RunHandler, true>;

  /**
   * @internal
   */
  constructor(options?: { telemetryProvider?: TelemetryProvider }) {
    this._telemetryProvider = options?.telemetryProvider;

    // Create the run procedure bound to this instance
    const instance = this;
    this.run = createProcedure(
      { name: "tentickle:run", handleFactory: false },
      async <P extends Record<string, unknown>>(
        element: { type: ComponentFunction<P>; props: P; key: string | number | null },
        input: RunInput<P> = {} as RunInput<P>,
      ): Promise<SessionExecutionHandle> => {
        const { model, props, messages = [], history = [], maxTicks, signal } = input;

        // Extract component and element props
        const Component = element.type;
        const elementProps = element.props;

        // Merge element props with input props (input props take precedence)
        const mergedProps = { ...elementProps, ...props } as P;

        // Create app options
        const appOptions: AppOptions = {};
        if (model) appOptions.model = model;
        if (maxTicks !== undefined) appOptions.maxTicks = maxTicks;
        if (signal) appOptions.signal = signal;

        // Create app and run using this instance
        const app = instance.createApp(Component, appOptions);
        return app.run({
          props: mergedProps,
          messages,
          history,
        });
      },
    );
  }

  /**
   * Register middleware for a procedure pattern.
   *
   * Keys can be:
   * - `'*'` - all procedures
   * - `'tool:*'` - all tool procedures (tool:run, etc.)
   * - `'model:*'` - all model procedures (model:generate, model:stream)
   * - `'tool:run'` - specific procedure name
   * - `'model:generate'` - specific procedure name
   *
   * Middleware is executed in order: global → category → specific
   *
   * @param key - Procedure pattern to match
   * @param middleware - Middleware functions to register
   * @returns this for chaining
   *
   * @example
   * ```typescript
   * Tentickle
   *   .use('*', loggingMiddleware)
   *   .use('tool:*', authMiddleware)
   *   .use('model:generate', rateLimitMiddleware);
   * ```
   */
  use(key: MiddlewareKey, ...middleware: Middleware[]): this {
    const existing = this.middlewareRegistry.get(key) || [];
    this.middlewareRegistry.set(key, [...existing, ...middleware]);
    return this;
  }

  /**
   * Get middleware matching a procedure name.
   *
   * Resolution order:
   * 1. Global ('*')
   * 2. Category wildcard (e.g., 'tool:*' matches 'tool:run')
   * 3. Exact match (e.g., 'tool:run')
   *
   * @param procedureName - The procedure name to match (e.g., 'tool:run', 'model:generate')
   * @returns Array of middleware functions in execution order
   */
  getMiddlewareFor(procedureName: string): Middleware[] {
    const result: Middleware[] = [];

    // 1. Global middleware ('*')
    const global = this.middlewareRegistry.get("*");
    if (global) result.push(...global);

    // 2. Category wildcard (e.g., 'tool:*' matches 'tool:run')
    const colonIndex = procedureName.indexOf(":");
    if (colonIndex > 0) {
      const category = procedureName.slice(0, colonIndex);
      const categoryWildcard = this.middlewareRegistry.get(`${category}:*`);
      if (categoryWildcard) result.push(...categoryWildcard);
    }

    // 3. Exact match
    const exact = this.middlewareRegistry.get(procedureName);
    if (exact) result.push(...exact);

    return result;
  }

  /**
   * Clear all registered middleware.
   * Useful for testing or resetting state.
   */
  clear(): this {
    this.middlewareRegistry.clear();
    return this;
  }

  /**
   * Get the telemetry provider.
   */
  get telemetryProvider(): TelemetryProvider | undefined {
    return this._telemetryProvider;
  }

  /**
   * Set the telemetry provider.
   */
  set telemetryProvider(provider: TelemetryProvider | undefined) {
    this._telemetryProvider = provider;
  }

  /**
   * Create a child instance.
   *
   * By default, the child inherits all middleware from this instance.
   * Use `inheritDefaults: false` for a completely isolated instance.
   *
   * @param options - Instance options
   * @returns A new TentickleInstance
   *
   * @example
   * ```typescript
   * // Create scoped instance that inherits global middleware
   * const scoped = Tentickle.create();
   * scoped.use('model:generate', rateLimitMiddleware);
   * const app = scoped.createApp(MyAgent);
   *
   * // Create isolated instance (no inheritance)
   * const isolated = Tentickle.create({ inheritDefaults: false });
   * ```
   */
  create(options: TentickleInstanceCreateOptions = {}): TentickleInstance {
    const child = new TentickleInstance({
      telemetryProvider: options.telemetryProvider ?? this._telemetryProvider,
    });

    // Copy middleware from parent unless inheritDefaults: false
    if (options.inheritDefaults !== false) {
      for (const [key, mws] of this.middlewareRegistry) {
        child.middlewareRegistry.set(key, [...mws]);
      }
    }

    return child;
  }

  /**
   * Create an app from a component function.
   *
   * The app inherits middleware from this Tentickle instance.
   *
   * @param Component - The component function that defines the Model Interface
   * @param options - App configuration options
   * @returns An App instance with run, send, and session methods
   *
   * @example
   * ```typescript
   * const MyAgent = ({ query }) => (
   *   <>
   *     <System>You are helpful.</System>
   *     <Timeline />
   *     <User>{query}</User>
   *   </>
   * );
   *
   * // Use global Tentickle
   * const app = createApp(MyAgent, { model });
   *
   * // Use scoped instance
   * const scoped = Tentickle.create();
   * scoped.use('tool:*', authMiddleware);
   * const scopedApp = scoped.createApp(MyAgent, { model });
   * ```
   */
  createApp<P extends Record<string, unknown>>(
    Component: ComponentFunction<P>,
    options: AppOptions = {},
  ): App<P> {
    const optionsWithInstance = { ...options, _tentickleInstance: this };

    return new AppImpl(Component, optionsWithInstance);
  }
}

/**
 * The default global Tentickle instance.
 *
 * All configuration and middleware registration starts here.
 * The exported `createApp` and `run` are bound to this instance.
 *
 * @example
 * ```typescript
 * import { Tentickle, createApp, run } from 'tentickle';
 *
 * // Configure global middleware
 * Tentickle.use('*', loggingMiddleware);
 * Tentickle.telemetryProvider = myProvider;
 *
 * // createApp and run use Tentickle
 * const app = createApp(MyAgent, { model });
 * const result = await run(<MyAgent />, { messages, model });
 *
 * // Create scoped instance with its own middleware
 * const scoped = Tentickle.create();
 * scoped.use('model:generate', specialMiddleware);
 * const scopedResult = await scoped.run(<MyAgent />, { messages, model });
 * ```
 */
export const Tentickle = new TentickleInstance();

/**
 * Create an app from a component function.
 *
 * This is `Tentickle.createApp` - apps inherit middleware from the global Tentickle instance.
 *
 * @example
 * ```typescript
 * import { createApp } from 'tentickle';
 *
 * const app = createApp(MyAgent, { model });
 * const result = await app.run({ props: { query: "Hello!" } });
 * ```
 */
export const createApp = Tentickle.createApp.bind(Tentickle);

/**
 * One-shot execution of a JSX component.
 *
 * This is `Tentickle.run` - the simplest way to run an agent.
 * Returns SessionExecutionHandle which is both PromiseLike and AsyncIterable.
 *
 * @example
 * ```typescript
 * import { run } from 'tentickle';
 *
 * // Await result
 * const result = await run(<MyAgent />, { messages, model });
 *
 * // Stream events
 * for await (const event of run(<MyAgent />, { messages, model })) {
 *   console.log(event);
 * }
 * ```
 */
export const run = Tentickle.run.bind(Tentickle);

// ============================================================================
// Types
// ============================================================================

/**
 * Input for the run() function.
 */
export interface RunInput<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Model instance to use for execution */
  model?: AppOptions["model"];
  /** Props to pass to the component */
  props?: P;
  /** Messages to queue before running */
  messages?: AppInput<P>["messages"];
  /** Conversation history to seed */
  history?: AppInput<P>["history"];
  /** Maximum number of ticks before stopping */
  maxTicks?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}
