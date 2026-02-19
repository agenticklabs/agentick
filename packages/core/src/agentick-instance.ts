/**
 * Agentick Configuration Instance
 *
 * `Agentick` is the default global instance. Users interact with instances, never the class directly.
 *
 * ```typescript
 * import { Agentick, createApp } from 'agentick';
 *
 * // Configure global instance
 * Agentick.use('*', loggingMiddleware);
 * Agentick.use('tool:*', authMiddleware);
 *
 * // createApp uses Agentick by default
 * const app = createApp(MyAgent, { model });
 *
 * // Create a scoped instance (inherits from Agentick)
 * const scoped = Agentick.create();
 * scoped.use('model:generate', rateLimitMiddleware);
 * const scopedApp = scoped.createApp(MyAgent, { model });
 *
 * // Create isolated instance (no inheritance)
 * const isolated = Agentick.create({ inheritDefaults: false });
 * ```
 *
 * @module agentick/@agentick/instance
 */

import {
  type Middleware,
  type TelemetryProvider,
  createProcedure,
  type Procedure,
} from "@agentick/kernel";
import type {
  App,
  RunInput,
  AppOptions,
  SessionOptions,
  Session,
  SessionExecutionHandle,
  ComponentFunction,
  ExecutionOptions,
  SendInput,
  InboxStorage,
  InboxMessageInput,
} from "./app/types";
import { randomUUID } from "node:crypto";
import { SessionImpl } from "./app/session";
import { MemoryInboxStorage } from "./app/inbox-storage";

/**
 * Key for middleware registration.
 * - `'*'` - matches all procedures
 * - `'tool:*'` - matches all tool procedures
 * - `'tool:run'` - matches specific procedure
 * - `'model:generate'` - matches specific procedure
 */
export type MiddlewareKey = string;

/**
 * Options for creating an AgentickInstance.
 */
export interface AgentickInstanceCreateOptions {
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
// Session Registry (App-managed sessions with auto-persist/restore)
// ============================================================================

import type { SessionStore, SessionSnapshot, SessionManagementOptions } from "./app/types";
import { createSessionStore } from "./app/sqlite-session-store";

interface SessionRegistryOptions<P> {
  // Session management options
  sessions?: SessionManagementOptions;

  // Callbacks
  onSessionClose?: (sessionId: string) => void;
  onBeforePersist?: (
    session: SessionImpl<P>,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;
  onAfterPersist?: (sessionId: string, snapshot: SessionSnapshot) => void | Promise<void>;
  onBeforeRestore?: (
    sessionId: string,
    snapshot: SessionSnapshot,
  ) => boolean | SessionSnapshot | void | Promise<boolean | SessionSnapshot | void>;
  onAfterRestore?: (session: SessionImpl<P>, snapshot: SessionSnapshot) => void | Promise<void>;
}

class SessionRegistry<P> {
  private sessions = new Map<string, SessionImpl<P>>();
  private lastActivity = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  // Resolved options
  private readonly store?: SessionStore;
  private readonly idleTimeout: number;
  private readonly maxActive: number;

  constructor(private readonly options: SessionRegistryOptions<P>) {
    const sessionsConfig = options.sessions ?? {};
    // Resolve store configuration (string path, config object, or SessionStore instance)
    this.store = createSessionStore(sessionsConfig.store);
    this.idleTimeout = sessionsConfig.idleTimeout ?? 0;
    this.maxActive = sessionsConfig.maxActive ?? 0;

    // Start sweep timer if we have an idle timeout
    if (this.idleTimeout > 0) {
      const interval = Math.max(1000, Math.min(this.idleTimeout, 30000));
      this.sweepTimer = setInterval(() => {
        try {
          this.sweep();
        } catch {
          /* non-fatal */
        }
      }, interval);
      if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
        this.sweepTimer.unref();
      }
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

    // Call onBeforeRestore hook
    if (this.options.onBeforeRestore) {
      const result = await this.options.onBeforeRestore(sessionId, snapshot);
      if (result === false) {
        return undefined; // Restore cancelled
      }
      if (result && typeof result === "object" && "version" in result) {
        // Use modified snapshot
        try {
          const session = createSession(result as SessionSnapshot);
          this.register(session.id, session);
          await this.options.onAfterRestore?.(session, result as SessionSnapshot);
          return session;
        } catch (err) {
          this.sessions.delete(sessionId);
          this.lastActivity.delete(sessionId);
          throw err;
        }
      }
    }

    // Create session from snapshot
    try {
      const session = createSession(snapshot);
      this.register(session.id, session);
      await this.options.onAfterRestore?.(session, snapshot);
      return session;
    } catch (err) {
      this.sessions.delete(sessionId);
      this.lastActivity.delete(sessionId);
      throw err;
    }
  }

  register(sessionId: string, session: SessionImpl<P>): void {
    this.sessions.set(sessionId, session);
    this.touch(sessionId);
    this.enforceMaxActive();
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Evict a session from memory (close it).
   * The snapshot remains in store (if any) for future restore.
   */
  async evict(sessionId: string): Promise<void> {
    await this.remove(sessionId, true);
  }

  async remove(sessionId: string, closeSession = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    this.lastActivity.delete(sessionId);

    if (closeSession) {
      await session.close();
    }

    this.options.onSessionClose?.(sessionId);
  }

  /**
   * Check if a store is configured.
   */
  hasStore(): boolean {
    return !!this.store;
  }

  /**
   * Persist a session snapshot to store (for auto-persist).
   */
  async persist(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    if (!this.store) return;

    // Call onBeforePersist hook
    let finalSnapshot = snapshot;
    if (this.options.onBeforePersist) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const result = await this.options.onBeforePersist(session, snapshot);
        if (result === false) return; // Persist cancelled
        if (result && typeof result === "object" && "version" in result) {
          finalSnapshot = result as SessionSnapshot;
        }
      }
    }

    await this.store.save(sessionId, finalSnapshot);

    // Call onAfterPersist hook — non-fatal after successful save
    try {
      await this.options.onAfterPersist?.(sessionId, finalSnapshot);
    } catch {
      // Hook errors after successful save are non-fatal
    }
  }

  /**
   * Permanently delete a session from both memory and store.
   */
  async delete(sessionId: string): Promise<void> {
    await this.remove(sessionId, true);
    if (this.store) {
      await this.store.delete(sessionId);
    }
  }

  async destroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.remove(sessionId, true)));
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

  private sweep(): void {
    if (this.idleTimeout <= 0) return;

    const now = Date.now();
    const toEvict: string[] = [];

    for (const [sessionId, last] of this.lastActivity.entries()) {
      if (now - last >= this.idleTimeout) {
        toEvict.push(sessionId);
      }
    }

    // Evict idle sessions (snapshots remain in store for future restore)
    // evict() is async but sweep is timer-driven — catch errors, don't block
    for (const sessionId of toEvict) {
      this.evict(sessionId).catch(() => {
        /* non-fatal */
      });
    }
  }

  private enforceMaxActive(): void {
    if (this.maxActive <= 0) return;

    while (this.sessions.size > this.maxActive) {
      const oldestId = this.sessions.keys().next().value as string | undefined;
      if (!oldestId) break;

      // evict() is async but enforceMaxActive is called during session creation —
      // the sync session removal from the map happens immediately in remove(),
      // async cleanup (runner onDestroy) runs in background
      this.evict(oldestId).catch(() => {
        /* non-fatal */
      });
    }
  }
}

// ============================================================================
// App Implementation
// ============================================================================

class AppImpl<P extends Record<string, unknown>> implements App<P> {
  readonly run: Procedure<(input: RunInput<P>) => SessionExecutionHandle, true>;

  private readonly registry: SessionRegistry<P>;
  private readonly sessionCreateHandlers = new Set<(session: Session<P>) => void>();
  private readonly sessionCloseHandlers = new Set<(sessionId: string) => void>();
  private readonly inboxStorage: InboxStorage;

  constructor(
    private readonly Component: ComponentFunction<P>,
    private readonly options: AppOptions,
  ) {
    this.inboxStorage = options.inbox ?? new MemoryInboxStorage();

    this.registry = new SessionRegistry<P>({
      sessions: options.sessions,
      // Callbacks
      onSessionClose: (sessionId) => {
        this.options.onSessionClose?.(sessionId);
        for (const handler of this.sessionCloseHandlers) {
          handler(sessionId);
        }
      },
      onBeforePersist: options.onBeforePersist as any,
      onAfterPersist: options.onAfterPersist,
      onBeforeRestore: options.onBeforeRestore,
      onAfterRestore: options.onAfterRestore as any,
    });

    this.run = createProcedure(
      {
        name: "app:run",
        handleFactory: false,
      },
      async (input: RunInput<P>): Promise<SessionExecutionHandle> => {
        const {
          props = {} as P,
          messages = [],
          history = [],
          maxTicks,
          signal,
          devTools,
          recording,
          tools,
        } = input;

        const sessionOptions: SessionOptions = {
          devTools: devTools ?? this.options.devTools,
          recording,
        };

        const executionOptions: ExecutionOptions = {
          maxTicks,
          signal,
          executionTools: tools,
        };

        const session = this.createSession(undefined, sessionOptions);

        // Seed timeline from history if provided
        if (history.length > 0) {
          session.setSnapshotForResolve({
            version: "1.0",
            sessionId: session.id,
            tick: 0,
            timeline: history,
            comState: {},
            dataCache: {},
            timestamp: Date.now(),
          });
        }

        for (const message of messages) {
          session.queue.exec(message);
        }

        const handle = await session.render(props, executionOptions);

        handle.result
          .finally(() => session.close())
          .catch(() => {
            // Prevent unhandled rejection - errors are captured in handle
          });

        return handle;
      },
    );
  }

  async send(
    input: SendInput<P>,
    options?: { sessionId?: string },
  ): Promise<SessionExecutionHandle> {
    const sessionId = options?.sessionId;

    if (!sessionId) {
      const session = this.createSession(undefined, {});
      const handle = await session.send(input);
      handle.result
        .finally(() => session.close())
        .catch(() => {
          // Prevent unhandled rejection - errors are captured in handle
        });
      return handle;
    }

    const session = await this.session(sessionId);
    const maybeModified = this.options.onBeforeSend?.(session, input) ?? input;
    const handle = await session.send(maybeModified);
    handle.result
      .then((result) => {
        this.options.onAfterSend?.(session, result);
      })
      .catch(() => {
        // Errors are already surfaced via lifecycle callbacks
      });
    return handle;
  }

  async session(idOrOptions?: string | SessionOptions): Promise<Session<P>> {
    // Parse arguments: string is ID, object is options
    let sessionId: string | undefined;
    let options: SessionOptions = {};

    if (typeof idOrOptions === "string") {
      sessionId = idOrOptions;
    } else if (idOrOptions !== undefined) {
      options = idOrOptions;
      sessionId = options.sessionId;
    }

    // If we have an ID, try to get existing or hydrate from store
    if (sessionId) {
      const existing = await this.registry.getOrHydrate(sessionId, (snapshot) =>
        this.createSessionFromSnapshot(snapshot, options),
      );
      if (existing) return existing;
    }

    // Create new session (ID will be generated if undefined)
    return this.createSession(sessionId, options);
  }

  async close(sessionId: string): Promise<void> {
    await this.registry.delete(sessionId);
  }

  get sessions(): readonly string[] {
    return this.registry.list();
  }

  has(sessionId: string): boolean {
    return this.registry.has(sessionId);
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

  async receive(message: InboxMessageInput): Promise<void> {
    const resolver = this.options.sessionResolver;
    let sessionId: string | null = null;
    if (resolver) {
      sessionId = await resolver(message);
    }
    if (!sessionId) {
      sessionId = randomUUID();
    }
    await this.inboxStorage.write(sessionId, message);
    // If session is active, subscriber fires immediately.
    // If not active, processInbox() or next session(id) call handles it.
  }

  async processInbox(): Promise<void> {
    const sessionIds = await this.inboxStorage.sessionsWithPending();
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const session = await this.session(sessionId);
        // setInboxStorage called during init triggers drainInbox.
        // If session was already alive, explicitly drain.
        await (session as SessionImpl<P>).processInboxMessages();
      }),
    );
  }

  private createSession(sessionId: string | undefined, options: SessionOptions): SessionImpl<P> {
    const sessionOptions: SessionOptions = {
      ...options,
      sessionId,
      devTools: options.devTools ?? this.options.devTools,
    };
    const session = new SessionImpl(this.Component, this.options, sessionOptions);

    this.initializeSession(session);
    this.registry.register(session.id, session);

    return session;
  }

  /**
   * Create a session from a stored snapshot.
   * Used by registry.getOrHydrate() - does NOT register (getOrHydrate handles that).
   */
  private createSessionFromSnapshot(
    snapshot: SessionSnapshot,
    options: SessionOptions,
  ): SessionImpl<P> {
    const sessionOptions: SessionOptions = {
      ...options,
      sessionId: snapshot.sessionId,
      devTools: options.devTools ?? this.options.devTools,
    };
    const session = new SessionImpl(this.Component, this.options, sessionOptions);

    // Use _snapshotForResolve instead of passing snapshot via SessionOptions.
    // This defers restoration to ensureCompilationInfrastructure() where
    // both Layer 1 (auto-apply) and Layer 2 (resolve) paths are handled.
    session.setSnapshotForResolve(snapshot);

    this.initializeSession(session);

    return session;
  }

  /**
   * Initialize session with callbacks and listeners.
   * Shared by createSession and createSessionFromSnapshot.
   */
  private initializeSession(session: SessionImpl<P>): void {
    // Set auto-persist callback if store is configured
    if (this.registry.hasStore()) {
      session.setPersistCallback(async (snapshot) => {
        await this.registry.persist(session.id, snapshot);
      });
    }

    // Connect session to inbox storage
    session.setInboxStorage(this.inboxStorage);

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
 * Agentick configuration instance.
 *
 * Users interact with instances, never the class directly.
 * `Agentick` is the default global instance.
 */
export class AgentickInstance implements MiddlewareRegistry {
  private middlewareRegistry = new Map<MiddlewareKey, Middleware[]>();
  private _telemetryProvider?: TelemetryProvider;

  /**
   * One-shot execution of a JSX component.
   *
   * Accepts a JSX element and optional RunInput. Creates a temporary app and session,
   * runs to completion, then cleans up.
   *
   * **Prop merging:** Element props are defaults, `input.props` override them.
   * `{ ...element.props, ...input.props }` — so `<Agent query="default" />` with
   * `{ props: { query: "override" } }` uses `"override"`.
   *
   * Returns SessionExecutionHandle (AsyncIterable, not PromiseLike):
   * - `await run(...).result` → SendResult
   * - `for await (const event of await run(...))` → StreamEvent
   *
   * @example Get result
   * ```typescript
   * const result = await Agentick.run(
   *   <MyAgent />,
   *   { messages: [{ role: "user", content: [...] }], model }
   * ).result;
   * ```
   *
   * @example Stream events
   * ```typescript
   * const handle = await Agentick.run(<MyAgent />, { messages, model });
   * for await (const event of handle) {
   *   if (event.type === 'content_delta') {
   *     process.stdout.write(event.delta);
   *   }
   * }
   * ```
   *
   * @example Add middleware to run
   * ```typescript
   * const loggedRun = Agentick.run.use(loggingMiddleware);
   * const result = await loggedRun(<MyAgent />, { messages, model }).result;
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
      { name: "agentick:run", handleFactory: false },
      async <P extends Record<string, unknown>>(
        element: { type: ComponentFunction<P>; props: P; key: string | number | null },
        input: RunInput<P> = {} as RunInput<P>,
      ): Promise<SessionExecutionHandle> => {
        const { model, props, ...runInput } = input;

        // Extract component and element props, input props override element props
        const Component = element.type;
        const mergedProps = { ...element.props, ...props } as P;

        // Create app options
        const appOptions: AppOptions = {};
        if (model) appOptions.model = model;

        // Create app and run using this instance
        const app = instance.createApp(Component, appOptions);
        return app.run({
          ...runInput,
          props: mergedProps,
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
   * Agentick
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
   * @returns A new AgentickInstance
   *
   * @example
   * ```typescript
   * // Create scoped instance that inherits global middleware
   * const scoped = Agentick.create();
   * scoped.use('model:generate', rateLimitMiddleware);
   * const app = scoped.createApp(MyAgent);
   *
   * // Create isolated instance (no inheritance)
   * const isolated = Agentick.create({ inheritDefaults: false });
   * ```
   */
  create(options: AgentickInstanceCreateOptions = {}): AgentickInstance {
    const child = new AgentickInstance({
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
   * The app inherits middleware from this Agentick instance.
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
   * // Use global Agentick
   * const app = createApp(MyAgent, { model });
   *
   * // Use scoped instance
   * const scoped = Agentick.create();
   * scoped.use('tool:*', authMiddleware);
   * const scopedApp = scoped.createApp(MyAgent, { model });
   * ```
   */
  createApp<P extends Record<string, unknown>>(
    Component: ComponentFunction<P>,
    options: AppOptions = {},
  ): App<P> {
    const optionsWithInstance = { ...options, _agentickInstance: this };

    return new AppImpl(Component, optionsWithInstance);
  }
}

/**
 * The default global Agentick instance.
 *
 * All configuration and middleware registration starts here.
 * The exported `createApp` and `run` are bound to this instance.
 *
 * @example
 * ```typescript
 * import { Agentick, createApp, run } from 'agentick';
 *
 * // Configure global middleware
 * Agentick.use('*', loggingMiddleware);
 * Agentick.telemetryProvider = myProvider;
 *
 * // createApp and run use Agentick
 * const app = createApp(MyAgent, { model });
 * const result = await run(<MyAgent />, { messages, model });
 *
 * // Create scoped instance with its own middleware
 * const scoped = Agentick.create();
 * scoped.use('model:generate', specialMiddleware);
 * const scopedResult = await scoped.run(<MyAgent />, { messages, model });
 * ```
 */
export const Agentick = new AgentickInstance();

/**
 * Create an app from a component function.
 *
 * This is `Agentick.createApp` - apps inherit middleware from the global Agentick instance.
 *
 * @example
 * ```typescript
 * import { createApp } from 'agentick';
 *
 * const app = createApp(MyAgent, { model });
 * const result = await app.run({ props: { query: "Hello!" } });
 * ```
 */
export const createApp = Agentick.createApp.bind(Agentick);

/**
 * One-shot execution of a JSX component.
 *
 * This is `Agentick.run` - the simplest way to run an agent.
 * Returns SessionExecutionHandle (AsyncIterable, not PromiseLike).
 *
 * @example
 * ```typescript
 * import { run } from 'agentick';
 *
 * // Get result
 * const result = await run(<MyAgent />, { messages, model }).result;
 *
 * // Stream events
 * const handle = await run(<MyAgent />, { messages, model });
 * for await (const event of handle) {
 *   console.log(event);
 * }
 * ```
 */
export const run = Agentick.run.bind(Agentick);

// RunInput is now defined in ./app/types and exported from the package index.
