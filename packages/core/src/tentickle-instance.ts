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
   * @returns An App instance with run and createSession methods
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

    return {
      /**
       * Run the app with input.
       *
       * Returns SessionExecutionHandle which is both PromiseLike and AsyncIterable:
       * - `await app.run(input)` → SendResult
       * - `for await (const event of app.run(input))` → StreamEvent
       */
      run: createProcedure({
        name: "app:run",
        handleFactory: false,
      }, (input: AppInput<P>): SessionExecutionHandle => {
        const { props = {} as P, messages = [], history = [], options: runOpts = {} } = input;

        const sessionOptions: SessionOptions = {
          ...runOpts,
          initialTimeline: history.length > 0 ? history : undefined,
        };

        const executionOptions = {
          maxTicks: runOpts.maxTicks,
          signal: runOpts.signal,
        };

        // Create session - it captures middleware from optionsWithInstance._tentickleInstance
        const session = new SessionImpl(Component, optionsWithInstance, sessionOptions);

        // Queue messages before tick
        for (const message of messages) {
          session.queueMessage(message);
        }

        // session.tick() returns SessionExecutionHandle (PromiseLike + AsyncIterable)
        const handle = session.tick(props, executionOptions);

        // Cleanup on completion (success or error)
        handle.result.finally(() => session.close()).catch(() => {
          // Prevent unhandled rejection - errors are captured in handle
        });

        return handle;
      }),

      /**
       * Create a persistent session for multi-turn conversations.
       */
      createSession(sessionOptions?: SessionOptions): Session<P> {
        // Session captures middleware from optionsWithInstance._tentickleInstance
        return new SessionImpl(Component, optionsWithInstance, sessionOptions ?? {});
      },
    };
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
