/**
 * New Procedure Implementation - Variable Arity, Decorators, Pipelines
 *
 * Design Principles:
 * - Everything is a Procedure
 * - Variable arity support (0, 1, N args)
 * - Decorator = Function (same type)
 * - Hooks are Procedures (@hook decorator)
 * - Pipelines for middleware bundles
 * - Direct calls (no registration)
 * - Automatic tracking (execution graph, telemetry)
 */

import type { EventEmitter } from "node:events";
import { Context, type KernelContext, isKernelContext } from "./context";
import { ExecutionTracker, type ExecutionBoundaryConfig } from "./execution-tracker";
import { ExecutionHandleBrand } from "./execution-handle-brand";
import { randomUUID } from "node:crypto";
import type { ProcedureNode } from "./procedure-graph";
import { AbortError, ValidationError } from "@agentick/shared";
import { EventBuffer, type TypedEvent } from "./event-buffer";
import { parseSchema } from "./schema";

// ============================================================================
// ProcedurePromise - Enhanced Promise with .result chaining
// ============================================================================

/**
 * Extract the result type from a handle-like object.
 * If T has a `result` property that is a Promise, extract its resolved type.
 */
export type ResultOf<T> = T extends { result: Promise<infer R> } ? R : T;

/**
 * Enhanced Promise returned by all procedures.
 *
 * ProcedurePromise extends Promise<T> with a `.result` property that chains
 * through to the inner result. This allows ergonomic access to final values
 * without losing access to the handle.
 *
 * @typeParam T - The type the promise resolves to (usually a handle or value)
 *
 * @example Get the handle
 * ```typescript
 * const handle = await run(<Agent />, opts);
 * handle.status;  // 'running'
 * for await (const event of handle) { }
 * ```
 *
 * @example Get the result directly
 * ```typescript
 * const result = await run(<Agent />, opts).result;
 * // Equivalent to: (await run(<Agent />, opts)).result
 * ```
 *
 * @example Both work
 * ```typescript
 * const promise = run(<Agent />, opts);
 * const handle = await promise;           // Get handle
 * const result = await promise.result;    // Get final result
 * ```
 */
export interface ProcedurePromise<T> extends Promise<T> {
  /**
   * Promise that resolves to the final result.
   * Chains through to T.result if T has a result property.
   */
  readonly result: Promise<ResultOf<T>>;
}

/**
 * Create a ProcedurePromise from a regular Promise.
 *
 * Adds a `.result` property that chains through to the inner handle's result.
 * If the resolved value has a `.result` property, `.result` resolves to that.
 * Otherwise, `.result` resolves to the value itself.
 *
 * @param promise - The base promise to enhance
 * @returns Enhanced ProcedurePromise with .result chaining
 */
export function createProcedurePromise<T>(promise: Promise<T>): ProcedurePromise<T> {
  const enhanced = promise as ProcedurePromise<T>;

  Object.defineProperty(enhanced, "result", {
    get() {
      return promise.then((value) => {
        // If the resolved value has a .result property, chain to it
        if (value && typeof value === "object" && "result" in value) {
          return (value as { result: Promise<unknown> }).result;
        }
        // Otherwise, return the value itself
        return value;
      });
    },
    enumerable: true,
    configurable: false,
  });

  return enhanced;
}

// ============================================================================
// Symbol Branding
// ============================================================================

/**
 * Symbol used to brand Procedure objects for deterministic type checking.
 * Using Symbol.for() ensures the same symbol across module instances.
 */
export const PROCEDURE_SYMBOL = Symbol.for("@agentick/kernel.procedure");

/**
 * Check if a value is a Procedure using Symbol branding.
 *
 * This is more reliable than duck typing because it uses a unique Symbol
 * that can only be present on objects created by the procedure system.
 *
 * @param value - The value to check
 * @returns True if the value is a branded Procedure
 *
 * @example
 * ```typescript
 * const proc = createProcedure(async (x: number) => x * 2);
 * isProcedure(proc); // true
 * isProcedure(() => {}); // false
 * isProcedure({ use: () => {} }); // false (duck typing would say true)
 * ```
 */
export function isProcedure(value: any): value is Procedure<any> {
  return value != null && typeof value === "function" && PROCEDURE_SYMBOL in value;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Middleware function that can intercept and transform procedure execution.
 *
 * Middleware can:
 * - Transform input arguments before passing to the next middleware/handler
 * - Modify the result after `next()` returns
 * - Short-circuit execution by not calling `next()`
 * - Handle or transform errors
 *
 * @typeParam TArgs - The argument types of the procedure
 *
 * @example
 * ```typescript
 * const loggingMiddleware: Middleware<[string]> = async (args, envelope, next) => {
 *   console.log(`${envelope.operationName} called with:`, args);
 *   const start = Date.now();
 *   try {
 *     const result = await next();
 *     console.log(`Completed in ${Date.now() - start}ms`);
 *     return result;
 *   } catch (error) {
 *     console.error(`Failed:`, error);
 *     throw error;
 *   }
 * };
 * ```
 *
 * @example Transform arguments
 * ```typescript
 * const upperMiddleware: Middleware<[string]> = async (args, envelope, next) => {
 *   return next([args[0].toUpperCase()]);
 * };
 * ```
 *
 * @see {@link ProcedureEnvelope} - The envelope containing execution metadata
 * @see {@link createPipeline} - Bundle multiple middleware for reuse
 */
export type Middleware<TArgs extends any[] = any[]> = (
  args: TArgs,
  envelope: ProcedureEnvelope<TArgs>,
  next: (transformedArgs?: TArgs) => Promise<any>,
) => Promise<any>;

/**
 * Metadata envelope passed to middleware containing execution context.
 *
 * @typeParam TArgs - The argument types of the procedure
 *
 * @example
 * ```typescript
 * const middleware: Middleware<[string]> = async (args, envelope, next) => {
 *   if (envelope.sourceType === 'hook') {
 *     console.log(`Hook ${envelope.operationName} from ${envelope.sourceId}`);
 *   }
 *   return next();
 * };
 * ```
 */
export interface ProcedureEnvelope<TArgs extends any[]> {
  /** Whether this is a regular procedure or a hook */
  sourceType: "procedure" | "hook";
  /** Identifier of the source (e.g., class name for decorated methods) */
  sourceId?: string;
  /** Name of the operation being executed */
  operationName: string;
  /** The arguments passed to the procedure */
  args: TArgs;
  /** The current kernel context */
  context: KernelContext;
  /** Procedure metadata (tool names, model IDs, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Handle for monitoring and controlling a running procedure execution.
 *
 * ExecutionHandle is AsyncIterable for streaming events.
 * Use `.result` to get the final value as a Promise.
 *
 * NOTE: ExecutionHandle is NOT PromiseLike. This is intentional - it allows
 * procedures to return ProcedurePromise<ExecutionHandle> where `await proc()`
 * gives you the handle (not the result). Use `await handle.result` for the
 * final value, or `await proc().result` for a one-liner.
 *
 * @typeParam TResult - The return type of the procedure
 * @typeParam TEvent - The event type for streaming (defaults to any)
 *
 * @example Get handle, then result
 * ```typescript
 * const handle = await myProc('input');
 * handle.status;  // 'running'
 * const result = await handle.result;
 * ```
 *
 * @example Get result directly
 * ```typescript
 * const result = await myProc('input').result;
 * ```
 *
 * @example Stream events
 * ```typescript
 * const handle = await myProc('input');
 * for await (const event of handle) {
 *   console.log('Event:', event);
 * }
 * ```
 *
 * @example Access status and control
 * ```typescript
 * const handle = await myProc('input');
 * console.log('Status:', handle.status);  // 'running'
 * handle.abort('user cancelled');
 * console.log('Status:', handle.status);  // 'aborted'
 * ```
 *
 * @see {@link ExecutionHandleImpl} - Default implementation
 * @see {@link HandleFactory} - Custom handle factory function type
 */
export interface ExecutionHandle<
  TResult,
  TEvent extends TypedEvent = any,
> extends AsyncIterable<TEvent> {
  /** Brand identifying this as an ExecutionHandle (not a plain AsyncIterable) */
  readonly [ExecutionHandleBrand]: true;
  /** Current execution status */
  readonly status:
    | "running"
    | "completed"
    | "error"
    | "aborted"
    | "cancelled"
    | "pending"
    | "failed";

  /** Trace ID for distributed tracing correlation */
  readonly traceId: string;

  /**
   * Event buffer for streaming execution events.
   * Supports dual consumption - multiple iterators can independently consume all events.
   * Late subscribers receive replayed events from the start.
   *
   * API is compatible with EventEmitter: on, once, off, emit, addListener, removeListener.
   * Use `on('eventType', handler)` to subscribe to specific event types.
   * Use `on(handler)` or `on('*', handler)` for wildcard subscription.
   */
  readonly events: EventBuffer<TEvent>;

  /** Abort the execution */
  abort(reason?: string): void;

  /**
   * Promise that resolves with the final result.
   * Use `await handle.result` to get the value.
   */
  readonly result: Promise<TResult>;

  // AsyncIterable implementation
  [Symbol.asyncIterator](): AsyncIterator<TEvent>;
}

/**
 * Default implementation of ExecutionHandle.
 *
 * Creates a handle that wraps a result promise and event stream.
 * Uses EventBuffer for dual consumption - multiple iterators can independently
 * consume all events, and late subscribers receive replayed events.
 *
 * @typeParam TResult - The return type of the procedure
 * @typeParam TEvent - The event type for streaming
 */
export class ExecutionHandleImpl<
  TResult,
  TEvent extends TypedEvent = any,
> implements ExecutionHandle<TResult, TEvent> {
  readonly [ExecutionHandleBrand] = true as const;
  private _status: "running" | "completed" | "error" | "aborted" = "running";
  private _abortController: AbortController;
  public readonly events: EventBuffer<TEvent>;

  constructor(
    public readonly result: Promise<TResult>,
    events: EventBuffer<TEvent>,
    public readonly traceId: string,
    abortController?: AbortController,
  ) {
    this._abortController = abortController ?? new AbortController();
    this.events = events;

    // Update status when result settles
    result.then(
      () => {
        if (this._status === "running") {
          this._status = "completed";
          this.events.close();
        }
      },
      (err) => {
        if (this._status === "running") {
          this._status = "error";
          this.events.error(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  }

  get status(): "running" | "completed" | "error" | "aborted" {
    return this._status;
  }

  abort(reason?: string): void {
    if (this._status === "running") {
      this._status = "aborted";
      this._abortController.abort(reason);
      this.events.close();
    }
  }

  /**
   * Push an event to the buffer.
   * This is the primary way to emit events from procedure handlers.
   */
  pushEvent(event: TEvent): void {
    this.events.push(event);
  }

  // AsyncIterable implementation - delegates to EventBuffer for dual consumption
  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return this.events[Symbol.asyncIterator]();
  }
}

/**
 * Factory function for creating custom execution handles.
 *
 * Use this to provide custom handle implementations with additional
 * functionality like cancellation, status tracking, or specialized events.
 *
 * @typeParam THandle - The custom handle type (must extend ExecutionHandle)
 * @typeParam TContext - The context type (must extend KernelContext)
 *
 * @example
 * ```typescript
 * const customHandleFactory: HandleFactory = (events, traceId, result, context, abortController) => {
 *   const handle = new ExecutionHandleImpl(result, events, traceId, abortController);
 *   // Add custom properties/methods
 *   return Object.assign(handle, {
 *     customMethod() { ... }
 *   });
 * };
 *
 * const proc = createProcedure(
 *   { handleFactory: customHandleFactory },
 *   async (input) => input
 * );
 * ```
 *
 * @see {@link ExecutionHandle} - The base handle interface
 * @see {@link ExecutionHandleImpl} - Default implementation
 */
export type HandleFactory<
  THandle extends ExecutionHandle<any, any> = ExecutionHandle<any, any>,
  TContext extends KernelContext = KernelContext,
> = (
  events: EventBuffer<any>,
  traceId: string,
  result: Promise<any>,
  context: TContext,
  abortController?: AbortController,
) => THandle;

/**
 * Configuration options for creating a procedure.
 *
 * @example
 * ```typescript
 * const proc = createProcedure({
 *   name: 'myProcedure',
 *   schema: z.object({ input: z.string() }),
 *   middleware: [loggingMiddleware],
 *   timeout: 5000,
 * }, async ({ input }) => input.toUpperCase());
 * ```
 *
 * @see {@link createProcedure} - Create a procedure with these options
 */
export interface ProcedureOptions {
  /** Name of the procedure (used in telemetry and logging) */
  name?: string;
  /** Middleware pipeline to apply to this procedure */
  middleware?: (Middleware<any[]> | MiddlewarePipeline)[];
  /**
   * Factory for creating execution handles.
   *
   * - `undefined` (default): Creates ExecutionHandleImpl, returns ExecutionHandle
   * - `HandleFactory`: Creates custom handle, returns that handle type
   * - `false`: Pass-through mode - no handle created, returns handler result directly
   *
   * Use `false` for procedures that delegate to other procedures returning handles,
   * avoiding double-wrapping.
   *
   * @example Pass-through procedure
   * ```typescript
   * const run = createProcedure(
   *   { name: 'agentick:run', handleFactory: false },
   *   (element, input) => app.run(input)  // Returns SessionExecutionHandle directly
   * );
   * ```
   */
  handleFactory?: HandleFactory | true | false;
  /**
   * Schema for input validation.
   * Supports Zod 3, Zod 4, Standard Schema, or any schema with parse/validate method.
   */
  schema?: unknown;
  /** Parent procedure name (for hooks) */
  parentProcedure?: string;
  /** @internal Whether this is a procedure or hook */
  sourceType?: "procedure" | "hook";
  /** @internal Source identifier (e.g., class name) */
  sourceId?: string;
  /** Metadata for telemetry span attributes (e.g., { type: 'tool', id: 'myTool' }) */
  metadata?: Record<string, any>;
  /** Timeout in milliseconds. If exceeded, throws AbortError.timeout() */
  timeout?: number;
  /**
   * Skip ExecutionTracker procedure tracking for this procedure.
   * Used for transparent wrappers like withContext() that delegate to another procedure.
   * @internal
   */
  skipTracking?: boolean;

  // ─────────────────────────────────────────────────────────────────────────────
  // Execution Boundary Configuration (Phase 3)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Declarative execution boundary configuration.
   *
   * - `'always'`: Always create a new root execution (engine:execute, engine:stream)
   * - `'child'`: Always create a new child execution (component_tool, fork, spawn)
   * - `'auto'`: Create only if not already in an execution (model:generate, model:stream)
   * - `false`: Never create an execution boundary (compile:tick, internal procedures)
   *
   * @default 'auto'
   */
  executionBoundary?: ExecutionBoundaryConfig;

  /**
   * Explicit execution type (e.g., 'engine', 'model', 'component_tool', 'fork', 'spawn').
   * If not provided, derived from procedure name.
   * Only used when this procedure becomes an execution boundary.
   */
  executionType?: string;
}

/**
 * A callable function wrapper with middleware, validation, and execution control.
 *
 * Procedures are the core execution primitive in Agentick. They wrap any async function
 * and provide:
 * - **Middleware pipeline** - Transform args, intercept results, handle errors
 * - **Schema validation** - Zod-based input validation
 * - **Execution handles** - Every call returns ExecutionHandle for control
 * - **Automatic tracking** - Every call is tracked in the procedure graph
 * - **Composition** - Chain procedures with `.pipe()`
 *
 * Procedures return ProcedurePromise wrapping ExecutionHandle (AsyncIterable):
 * - `await proc(args)` → ExecutionHandle (status, abort, streaming)
 * - `await proc(args).result` → the final value
 * - `for await (const event of await proc(args))` → streams events
 *
 * @typeParam THandler - The function type being wrapped
 *
 * @example Get handle, then result
 * ```typescript
 * const greet = createProcedure(async (name: string) => `Hello, ${name}!`);
 * const handle = await greet('World');
 * const result = await handle.result; // 'Hello, World!'
 * ```
 *
 * @example Stream events
 * ```typescript
 * const handle = await proc(input);
 * for await (const event of handle) {
 *   console.log('Event:', event);
 * }
 * ```
 *
 * @example Access handle status
 * ```typescript
 * const handle = proc(input);
 * console.log('Status:', handle.status);  // 'running'
 * handle.abort('cancelled');
 * ```
 *
 * @example With middleware
 * ```typescript
 * const proc = createProcedure(async (x: number) => x * 2)
 *   .use(loggingMiddleware)
 *   .use(timingMiddleware);
 * ```
 *
 * @see {@link createProcedure} - Create a new procedure
 * @see {@link Middleware} - Middleware function type
 * @see {@link ExecutionHandle} - Handle for execution control
 */
export interface Procedure<
  THandler extends (...args: any[]) => any,
  TPassThrough extends boolean = false,
> {
  /**
   * Call the procedure directly.
   * Returns ProcedurePromise — supports `.result` chaining in all modes.
   *
   * Usage:
   * - `await proc()` → ExecutionHandle (or T in passthrough mode)
   * - `await proc().result` → T (the final value)
   */
  (
    ...args: ExtractArgs<THandler>
  ): TPassThrough extends true
    ? ProcedurePromise<ExtractReturn<THandler>>
    : ProcedurePromise<ExecutionHandle<ExtractReturn<THandler>>>;

  /**
   * Execute the procedure with explicit arguments.
   * Equivalent to direct call.
   */
  exec(
    ...args: ExtractArgs<THandler>
  ): TPassThrough extends true
    ? ProcedurePromise<ExtractReturn<THandler>>
    : ProcedurePromise<ExecutionHandle<ExtractReturn<THandler>>>;

  /**
   * Add middleware to the procedure. Returns a new Procedure (immutable).
   * Typed overload preserves IntelliSense for inline middleware.
   * Generic overload accepts pre-built middleware (guards, logging, etc.).
   */
  use(
    ...middleware: (Middleware<ExtractArgs<THandler>> | MiddlewarePipeline)[]
  ): Procedure<THandler, TPassThrough>;
  use(...middleware: (Middleware | MiddlewarePipeline)[]): Procedure<THandler, TPassThrough>;

  /**
   * Create a procedure variant with merged context. Returns a new Procedure.
   * @param ctx - Partial context to merge with the current context
   */
  withContext(ctx: Partial<KernelContext>): Procedure<THandler, TPassThrough>;

  /**
   * Add a single middleware. Returns a new Procedure.
   * Convenience method equivalent to `.use(mw)`.
   */
  withMiddleware(
    mw: Middleware<ExtractArgs<THandler>> | Middleware | MiddlewarePipeline,
  ): Procedure<THandler, TPassThrough>;

  /**
   * Create a procedure variant with a timeout. Returns a new Procedure.
   * Throws `AbortError.timeout()` if the timeout is exceeded.
   * @param ms - Timeout in milliseconds
   */
  withTimeout(ms: number): Procedure<THandler, TPassThrough>;

  /**
   * Create a procedure variant with merged metadata. Returns a new Procedure.
   * Metadata is passed to ExecutionTracker and included in procedure events.
   * Useful for passing model IDs, tool names, or other execution-specific info.
   *
   * @param metadata - Metadata to merge with existing procedure metadata
   *
   * @example
   * ```typescript
   * // Model adapter passes model info
   * const result = await model.generate
   *   .withMetadata({ modelId: 'gpt-4o', provider: 'openai' })
   *   .exec(messages);
   *
   * // Tool passes tool info
   * const result = await tool.execute
   *   .withMetadata({ toolName: 'search', toolId: 'search-v2' })
   *   .exec(input);
   * ```
   */
  withMetadata(metadata: Record<string, unknown>): Procedure<THandler, TPassThrough>;

  /**
   * Pipe the output of this procedure to another procedure.
   * Creates a new procedure that runs this procedure, then passes its result to the next.
   *
   * @example
   * ```typescript
   * const parse = createProcedure(async (input: string) => JSON.parse(input));
   * const validate = createProcedure(async (data: object) => schema.parse(data));
   * const transform = createProcedure(async (valid: Valid) => transform(valid));
   *
   * const pipeline = parse.pipe(validate).pipe(transform);
   * const result = await pipeline('{"name": "test"}');
   * ```
   */
  pipe<TNext extends (arg: ExtractReturn<THandler>) => any>(
    next: Procedure<TNext>,
  ): Procedure<(...args: ExtractArgs<THandler>) => Promise<ExtractReturn<TNext>>, TPassThrough>;
}

/**
 * Helper type to extract argument types from a function signature.
 * Handles functions with `this` parameters and generator functions.
 *
 * @example
 * ```typescript
 * type Args1 = ExtractArgs<(input: string) => void>; // [string]
 * type Args2 = ExtractArgs<(this: Test, input: string) => void>; // [string]
 * type Args3 = ExtractArgs<() => Generator<string>>; // []
 * ```
 */
export type ExtractArgs<T> = T extends {
  (this: infer _This, ...args: infer Args): any;
}
  ? Args
  : T extends {
        (...args: infer Args): any;
      }
    ? Args
    : T extends {
          (this: infer _This, ...args: infer Args): Generator<infer _Y, infer _R, infer _N>;
        }
      ? Args
      : T extends {
            (...args: infer Args): Generator<infer _Y, infer _R, infer _N>;
          }
        ? Args
        : T extends {
              (
                this: infer _This,
                ...args: infer Args
              ): AsyncGenerator<infer _Y, infer _R, infer _N>;
            }
          ? Args
          : T extends {
                (...args: infer Args): AsyncGenerator<infer _Y, infer _R, infer _N>;
              }
            ? Args
            : never;

/**
 * Helper type to extract return type from a function signature.
 * Handles both Promise and direct returns, and unwraps Promise.
 * Preserves AsyncIterable as-is.
 */
export type ExtractReturn<T> = T extends (...args: any[]) => infer Return
  ? Return extends Promise<infer U>
    ? U
    : Return extends AsyncIterable<any>
      ? Return
      : Return
  : never;

/**
 * Helper type to transform a method signature to Procedure type.
 * Extracts args and return type, then creates Procedure<TArgs, TOutput>.
 *
 * Use this type to get proper IntelliSense for decorated methods:
 *
 * @example
 * ```typescript
 * class Model {
 *   @procedure()
 *   async execute(input: string): Promise<string> { ... }
 * }
 *
 * // For IntelliSense, you can use:
 * type ModelWithProcedures = {
 *   execute: AsProcedure<Model['execute']>;
 * };
 *
 * // Or cast at usage:
 * const model = new Model();
 * const execute = model.execute as AsProcedure<typeof model.execute>;
 * ```
 */
export type AsProcedure<T extends (...args: any[]) => any> = Procedure<T>;

/**
 * Helper type to transform all methods in a class to Procedures.
 *
 * **Primary Use Case**: Use with decorators when you need IntelliSense.
 *
 * ```typescript
 * class Model {
 *   @procedure()
 *   async execute(input: string): Promise<string> { ... }
 * }
 *
 * // Most of the time - runtime works perfectly, no types needed
 * const model = new Model();
 * await model.execute('test');  // ✅ Works
 *
 * // When you need IntelliSense - cast once
 * const typedModel = model as WithProcedures<Model>;
 * typedModel.execute.use(...);        // ✅ Full IntelliSense
 * typedModel.execute.withHandle();    // ✅ Full IntelliSense
 * ```
 *
 * **Alternative**: Use property initializers for full types everywhere:
 * ```typescript
 * class Model {
 *   execute = createProcedure(async (input: string) => input);
 *   // ✅ Full types always, but more verbose
 * }
 * ```
 */
export type WithProcedures<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? AsProcedure<T[K]> : T[K];
};

// ============================================================================
// Pipeline (Middleware Bundles)
// ============================================================================

/**
 * A reusable bundle of middleware that can be applied to procedures.
 *
 * Pipelines allow you to define common middleware combinations once
 * and reuse them across multiple procedures.
 *
 * @example
 * ```typescript
 * const commonPipeline = createPipeline()
 *   .use(loggingMiddleware)
 *   .use(timingMiddleware)
 *   .use(errorHandlingMiddleware);
 *
 * const proc1 = createProcedure(handler1).use(commonPipeline);
 * const proc2 = createProcedure(handler2).use(commonPipeline);
 * ```
 *
 * @see {@link createPipeline} - Create a new middleware pipeline
 * @see {@link Middleware} - Individual middleware function type
 */
export interface MiddlewarePipeline {
  /** Add middleware to this pipeline. Returns the pipeline for chaining. */
  use(...middleware: Middleware<any[]>[]): MiddlewarePipeline;
  /** Get all middleware in this pipeline. */
  getMiddleware(): Middleware<any[]>[];
}

/**
 * Create a reusable middleware pipeline.
 *
 * Pipelines bundle multiple middleware together for reuse across procedures.
 * They can be passed to `procedure.use()` just like individual middleware.
 *
 * @param middleware - Initial middleware to include in the pipeline
 * @returns A new MiddlewarePipeline
 *
 * @example
 * ```typescript
 * // Create a pipeline with initial middleware
 * const authPipeline = createPipeline([authMiddleware, rateLimitMiddleware]);
 *
 * // Or build it up with .use()
 * const logPipeline = createPipeline()
 *   .use(requestLogging)
 *   .use(responseLogging);
 *
 * // Apply to procedures
 * const proc = createProcedure(handler)
 *   .use(authPipeline)
 *   .use(logPipeline);
 * ```
 *
 * @see {@link MiddlewarePipeline} - The pipeline interface
 */
export function createPipeline(middleware: Middleware<any[]>[] = []): MiddlewarePipeline {
  const middlewares: Middleware<any[]>[] = [...middleware];

  return {
    use(...mw: Middleware<any[]>[]) {
      middlewares.push(...mw);
      return this;
    },
    getMiddleware() {
      return middlewares;
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

export function isAsyncIterable(obj: any): obj is AsyncIterable<any> {
  return obj && typeof obj[Symbol.asyncIterator] === "function";
}

function flattenMiddleware<TArgs extends any[]>(
  middleware: (Middleware<TArgs> | MiddlewarePipeline)[],
): Middleware<TArgs>[] {
  const flattened: Middleware<TArgs>[] = [];
  for (const mw of middleware) {
    if ("getMiddleware" in mw && typeof mw.getMiddleware === "function") {
      flattened.push(...(mw.getMiddleware() as unknown as Middleware<TArgs>[]));
    } else {
      flattened.push(mw as unknown as Middleware<TArgs>);
    }
  }
  return flattened;
}

// ============================================================================
// Procedure Class
// ============================================================================

/**
 * Procedure class - instances are callable functions with methods.
 * TOutput is inferred from the handler's return type.
 *
 * @example
 * ```typescript
 * const proc = new ProcedureImpl(
 *   { name: 'execute' },
 *   async (input: string) => input.toUpperCase()  // TOutput inferred as string
 * );
 *
 * await proc('test');  // ✅ Callable
 * proc.use(...);       // ✅ Has methods
 * ```
 */
/**
 * Internal middleware type for procedure execution.
 */
type InternalMiddleware<TArgs extends any[], TReturn> = (
  args: TArgs,
  ctx: KernelContext,
  next: (transformedArgs?: TArgs) => Promise<TReturn>,
) => Promise<TReturn>;

class ProcedureImpl<
  TArgs extends any[] = any[],
  THandler extends (...args: TArgs) => any = (...args: TArgs) => any,
> {
  private internalMiddlewares: InternalMiddleware<TArgs, ExtractReturn<THandler>>[] = [];
  private middlewares: Middleware<TArgs>[] = [];
  private schema?: unknown;
  private procedureName?: string;
  private sourceType: "procedure" | "hook" = "procedure";
  private sourceId?: string;
  private handleFactory?: HandleFactory | true | false;
  private metadata?: Record<string, any>; // For telemetry span attributes
  private handler?: THandler;
  private timeout?: number; // Timeout in milliseconds
  private skipTracking?: boolean; // Skip ExecutionTracker for transparent wrappers
  private executionBoundary?: ExecutionBoundaryConfig; // Execution boundary config (Phase 3)
  private executionType?: string; // Explicit execution type (Phase 3)

  constructor(options: ProcedureOptions = {}, handler?: THandler) {
    this.procedureName = options.name;
    this.schema = options.schema;
    this.sourceType = options.sourceType || "procedure";
    this.sourceId = options.sourceId;
    this.handleFactory = options.handleFactory;
    this.metadata = options.metadata; // Store metadata for telemetry
    this.timeout = options.timeout; // Store timeout
    this.skipTracking = options.skipTracking; // Store skipTracking flag
    this.executionBoundary = options.executionBoundary; // Execution boundary config (Phase 3)
    this.executionType = options.executionType; // Explicit execution type (Phase 3)

    if (options.middleware) {
      this.middlewares = flattenMiddleware(
        options.middleware as unknown as (Middleware<TArgs> | MiddlewarePipeline)[],
      );
    }

    // Adapt Procedure middleware to internal middleware format
    for (const mw of this.middlewares) {
      const adaptedMw: InternalMiddleware<TArgs, ExtractReturn<THandler>> = async (
        args,
        ctx,
        nextFn,
      ) => {
        const envelope: ProcedureEnvelope<TArgs> = {
          sourceType: this.sourceType,
          sourceId: this.sourceId,
          operationName: this.procedureName || "anonymous",
          args,
          context: ctx,
          metadata: this.metadata,
        };
        return mw(args, envelope, async (transformedArgs?: TArgs) => {
          return nextFn(transformedArgs);
        });
      };
      this.internalMiddlewares.push(adaptedMw);
    }

    // Set handler if provided
    if (handler) {
      this.handler = handler;
    }
  }

  /**
   * Set the handler function. Returns a new Procedure with the handler set.
   */
  setHandler<TNewHandler extends (...args: TArgs) => any>(fn: TNewHandler): Procedure<TNewHandler> {
    return createProcedureFromImpl<TArgs, TNewHandler>(
      {
        name: this.procedureName,
        schema: this.schema,
        middleware: this.middlewares as unknown as (Middleware<any[]> | MiddlewarePipeline)[],
        handleFactory: this.handleFactory,
        sourceType: this.sourceType,
        sourceId: this.sourceId,
        metadata: this.metadata, // Preserve metadata when setting new handler
        // Preserve execution tracking options (Phase 3)
        executionBoundary: this.executionBoundary,
        executionType: this.executionType,
        skipTracking: this.skipTracking,
        timeout: this.timeout,
      },
      fn,
    );
  }

  /**
   * Internal execution method - runs middleware pipeline and handler.
   */
  private async runMiddlewarePipeline(
    args: TArgs,
    context: KernelContext,
  ): Promise<ExtractReturn<THandler>> {
    if (!this.handler) {
      throw new Error(
        "Procedure handler not set. Call constructor with handler or use .setHandler() method.",
      );
    }

    // Get context middleware at execution time (from Agentick instance)
    // This enables runtime middleware configuration that can differ per-app or per-request
    const procedureName = this.procedureName || "anonymous";
    const contextMiddleware: InternalMiddleware<TArgs, ExtractReturn<THandler>>[] = [];

    if (context.middleware?.getMiddlewareFor) {
      const externalMiddleware = context.middleware.getMiddlewareFor(procedureName);
      for (const mw of externalMiddleware) {
        // Adapt external middleware to internal format
        const adaptedMw: InternalMiddleware<TArgs, ExtractReturn<THandler>> = async (
          mwArgs,
          ctx,
          nextFn,
        ) => {
          const envelope: ProcedureEnvelope<TArgs> = {
            sourceType: this.sourceType,
            sourceId: this.sourceId,
            operationName: procedureName,
            args: mwArgs,
            context: ctx,
            metadata: this.metadata,
          };
          // Cast envelope to any[] version since external middleware uses Middleware<any[]>
          return mw(
            mwArgs as any[],
            envelope as ProcedureEnvelope<any[]>,
            async (transformedArgs?: any[]) => {
              return nextFn(transformedArgs as TArgs | undefined);
            },
          );
        };
        contextMiddleware.push(adaptedMw);
      }
    }

    // Combine: context middleware runs first, then instance middleware
    const allMiddleware = [...contextMiddleware, ...this.internalMiddlewares];

    // Helper function to run the middleware pipeline
    const executeMiddlewarePipeline = async (): Promise<ExtractReturn<THandler>> => {
      // Check Abort Signal before starting
      if (context?.signal?.aborted) {
        throw new AbortError();
      }

      // Run Middleware Pipeline
      let index = 0;
      let currentInput: TArgs = args;

      const runMiddleware = async (transformedInput?: TArgs): Promise<ExtractReturn<THandler>> => {
        // Check Abort Signal before each middleware/handler
        if (context?.signal?.aborted) {
          throw new AbortError();
        }

        // Update current input if middleware provided transformed input
        if (transformedInput !== undefined) {
          currentInput = transformedInput;
        }

        if (index < allMiddleware.length) {
          const middleware = allMiddleware[index++];
          const result = await middleware(currentInput, context, runMiddleware);
          // Check Abort Signal after middleware execution (middleware might have aborted)
          if (context?.signal?.aborted) {
            throw new AbortError();
          }
          return result;
        } else {
          // Check Abort Signal before handler
          if (context?.signal?.aborted) {
            throw new AbortError();
          }

          // Call handler with current input (which may have been transformed)
          const result = this.handler!(...currentInput);
          // Handler can return anything - Promise.resolve handles Promise, value, or AsyncIterable
          return result as ExtractReturn<THandler>;
        }
      };

      return runMiddleware();
    };

    // Skip ExecutionTracker for transparent wrappers (e.g., withContext)
    // This prevents duplicate procedure tracking when a wrapper delegates to another procedure
    if (this.skipTracking) {
      return executeMiddlewarePipeline();
    }

    // Wrap execution with ExecutionTracker
    return ExecutionTracker.track(
      context,
      {
        name: this.procedureName || `procedure:${this.handler.name || "anonymous"}`,
        parentPid: context.procedurePid,
        metadata: this.metadata, // Pass metadata to ExecutionTracker for span attributes
        // Execution boundary configuration (Phase 3)
        executionBoundary: this.executionBoundary,
        executionType: this.executionType,
      },
      async (_node: ProcedureNode) => {
        return executeMiddlewarePipeline();
      },
    );
  }

  /**
   * Internal execution method.
   */
  async execute(
    args: TArgs,
    options?: Partial<KernelContext>,
    opEvents?: EventEmitter,
  ): Promise<ExtractReturn<THandler>> {
    if (!this.handler) {
      throw ValidationError.required(
        "handler",
        "Procedure handler not set. Call constructor with handler or use .setHandler() method.",
      );
    }

    // Validate input if schema provided
    let validatedArgs = args;
    if (this.schema && args.length > 0) {
      const validated = await parseSchema(this.schema, args[0]);
      validatedArgs = [validated, ...args.slice(1)] as TArgs;
    }

    // Resolve context: either create new root or derive child from current
    let context: KernelContext;
    const currentContext = Context.tryGet();

    // Detect if we have "real" context overrides (not just signal/traceId from createHandle)
    const hasRealOverrides =
      options &&
      Object.keys(options).some((k) => k !== "signal" && k !== "traceId" && k !== "events");

    if (!currentContext) {
      // No existing context - create a new root context
      context = Context.create(options);
      // If opEvents was provided, use it instead of the auto-created events emitter
      // (Context.create always creates a new EventEmitter, we need to override it)
      if (opEvents) {
        (context as any).events = opEvents;
      }
    } else if (hasRealOverrides) {
      // Existing context with meaningful overrides - create a child context
      // This ensures we don't mutate the parent's context object
      context = Context.child({
        ...options,
        events: opEvents ?? options?.events ?? currentContext.events,
        channels: options?.channels ?? currentContext.channels,
      });
    } else {
      // Existing context, no meaningful overrides - reuse as-is
      // This preserves procedureGraph sharing with parent context
      context = currentContext;
    }

    // Create handle if handleFactory is provided and handle doesn't exist
    if (this.handleFactory && !context.executionHandle) {
      const events = new EventBuffer<any>();
      const traceId = context.traceId || randomUUID();
      const resultPromise = Promise.resolve() as Promise<any>;
      // Only call handleFactory if it's a function, otherwise use default implementation
      const handle =
        typeof this.handleFactory === "function"
          ? this.handleFactory(events, traceId, resultPromise, context)
          : new ExecutionHandleImpl(resultPromise, events, traceId);
      context.executionHandle = handle as any as EventEmitter;
    }

    const currentStore = Context.tryGet();
    const isRoot = context !== currentStore;

    const executeInternal = async (): Promise<ExtractReturn<THandler>> => {
      let result: ExtractReturn<THandler>;
      if (isRoot) {
        result = await Context.run(context!, async () =>
          this.runMiddlewarePipeline(validatedArgs, context!),
        );
      } else {
        result = await this.runMiddlewarePipeline(validatedArgs, context!);
      }

      // AsyncIterables are now fully handled by ExecutionTracker (context, procedure:end/error)
      // No additional wrapping needed here - just return the result
      // ExecutionTracker wraps AsyncIterables to:
      // 1. Maintain the forked context with procedurePid during iteration
      // 2. Emit procedure:end when iteration completes
      // 3. Emit procedure:error on errors

      return result as ExtractReturn<THandler>;
    };

    // Apply timeout if configured
    if (this.timeout && this.timeout > 0) {
      return this.withTimeoutRace(executeInternal(), this.timeout);
    }

    return executeInternal();
  }

  /**
   * Race execution against a timeout.
   */
  private async withTimeoutRace<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(AbortError.timeout(timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Execute the procedure and return a ProcedurePromise.
   *
   * All procedures return ProcedurePromise<T> consistently:
   * - `await proc()` → T (the value or handle)
   * - `await proc().result` → final result (chains to T.result if exists)
   *
   * By default, procedures are PASS-THROUGH:
   * - T is whatever the handler returns
   * - If handler returns something with .result, proc().result chains to it
   *
   * To wrap in ExecutionHandle, provide a handleFactory:
   * - T is ExecutionHandle<HandlerReturn>
   * - handle.result is the handler's return value
   */
  exec(
    ...args: TArgs
  ): ProcedurePromise<
    typeof this.handleFactory extends HandleFactory
      ? ExecutionHandle<ExtractReturn<THandler>>
      : ExtractReturn<THandler>
  > {
    // Pass-through mode ONLY when handleFactory === false explicitly
    if (this.handleFactory === false) {
      return this.executePassThrough(args) as any;
    }
    // Default: handle wrapping (handleFactory: undefined, true, or function)
    return this.executeWithHandle(args) as any;
  }

  /**
   * Execute in pass-through mode - returns ProcedurePromise<T>.
   * Used when handleFactory: false.
   *
   * Always returns ProcedurePromise for consistency, even when there's no middleware.
   * This ensures `await proc()` and `await proc().result` always work predictably.
   */
  private executePassThrough(args: TArgs): ProcedurePromise<ExtractReturn<THandler>> {
    const promise = (async (): Promise<ExtractReturn<THandler>> => {
      // Validate if schema provided
      let validatedArgs = args;
      if (this.schema && args.length > 0) {
        const validated = await parseSchema(this.schema, args[0]);
        validatedArgs = [validated, ...args.slice(1)] as TArgs;
      }

      // If no middleware and no timeout, call handler directly
      // But still check abort signal first
      if (this.middlewares.length === 0 && !this.timeout) {
        const ctx = Context.tryGet();
        if (ctx?.signal?.aborted) {
          throw new AbortError();
        }
        return this.handler!(...validatedArgs) as ExtractReturn<THandler>;
      }

      // Otherwise go through the middleware chain
      return this.execute(validatedArgs);
    })();

    return createProcedurePromise(promise);
  }

  /**
   * Execute with handle wrapping - returns ProcedurePromise<ExecutionHandle<T>>.
   * Used when handleFactory is provided (not false).
   */
  private executeWithHandle(
    args: TArgs,
  ): ProcedurePromise<ExecutionHandle<ExtractReturn<THandler>>> {
    const handle = this.createHandle(args);
    // Wrap the synchronously-created handle in a ProcedurePromise
    return createProcedurePromise(Promise.resolve(handle));
  }

  /**
   * Create an ExecutionHandle for the given args.
   * This is the core method that creates the handle and starts execution.
   */
  private createHandle(args: TArgs): ExecutionHandle<ExtractReturn<THandler>> {
    const events = new EventBuffer<any>();
    const traceId = Context.tryGet()?.traceId || randomUUID();
    const abortController = new AbortController();

    // Create the result promise that will resolve when execution completes
    const resultPromise = (async (): Promise<ExtractReturn<THandler>> => {
      // Validate input if schema provided
      let validatedArgs = args;
      if (this.schema && args.length > 0) {
        const validated = await parseSchema(this.schema, args[0]);
        validatedArgs = [validated, ...args.slice(1)] as TArgs;
      }

      // Execute with the events buffer - it has EventEmitter-compatible API
      return this.execute(
        validatedArgs,
        { signal: abortController.signal, traceId },
        events as any, // EventBuffer is API-compatible with EventEmitter
      );
    })();

    // Create handle using factory or default implementation
    if (this.handleFactory && typeof this.handleFactory === "function") {
      const context = Context.tryGet() || Context.create({ traceId });
      return this.handleFactory(events, traceId, resultPromise, context, abortController);
    }

    return new ExecutionHandleImpl(resultPromise, events, traceId, abortController);
  }

  /**
   * Add middleware to the procedure. Returns a new Procedure.
   */
  use(...middleware: (Middleware<TArgs> | Middleware | MiddlewarePipeline)[]): Procedure<THandler> {
    const flattened = flattenMiddleware(
      middleware as unknown as (Middleware<TArgs> | MiddlewarePipeline)[],
    );
    return createProcedureFromImpl<TArgs, THandler>(
      {
        name: this.procedureName,
        schema: this.schema,
        middleware: [...this.middlewares, ...flattened] as unknown as (
          | Middleware<any[]>
          | MiddlewarePipeline
        )[],
        handleFactory: this.handleFactory,
        sourceType: this.sourceType,
        sourceId: this.sourceId,
        metadata: this.metadata, // Preserve metadata when adding middleware
        // Preserve execution tracking options (Phase 3)
        executionBoundary: this.executionBoundary,
        executionType: this.executionType,
        skipTracking: this.skipTracking,
        timeout: this.timeout,
      },
      this.handler!,
    );
  }

  /**
   * Create a procedure variant with merged context. Returns a new Procedure.
   *
   * IMPORTANT: This does NOT copy middleware to the new procedure. The middleware
   * runs when proc.execute() is called in the wrapped handler. Copying middleware
   * would cause double execution since execute() runs its own middleware chain.
   */
  withContext(ctx: Partial<KernelContext>): Procedure<THandler> {
    const proc = this;
    // Create a wrapper that merges context BEFORE execution
    const wrappedHandler = (async (...args: TArgs) => {
      // Get current context and merge
      // Note: Signal should come from ExecutionHandle, not Context inheritance
      // Context signal is only for external aborts (e.g., user-provided), not execution lifecycle
      const currentCtx = Context.tryGet() || Context.create();
      const mergedCtx = { ...currentCtx, ...ctx };

      // Run with merged context - this ensures middleware sees the merged context
      return Context.run(mergedCtx, async () => {
        // Call the original procedure's execute method with merged context as options
        // This ensures the merged context is used throughout execution
        return proc.execute(args, ctx);
      });
    }) as THandler;

    // Don't copy middleware here! The original proc.execute() will run its middleware.
    // Copying middleware would cause double execution.
    // Skip tracking for this wrapper - the inner proc.execute() will handle tracking.
    return createProcedureFromImpl<TArgs, THandler>(
      {
        name: this.procedureName,
        schema: this.schema,
        middleware: [], // Empty - middleware runs in proc.execute()
        handleFactory: this.handleFactory,
        sourceType: this.sourceType,
        sourceId: this.sourceId,
        metadata: this.metadata, // Preserve metadata for telemetry
        skipTracking: true, // Wrapper delegates to original - don't double-track
      },
      wrappedHandler,
    );
  }

  /**
   * Add a single middleware. Returns a new Procedure.
   */
  withMiddleware(mw: Middleware<TArgs> | Middleware | MiddlewarePipeline): Procedure<THandler> {
    return this.use(mw);
  }

  /**
   * Create a procedure variant with a timeout. Returns a new Procedure.
   * Throws AbortError.timeout() if the timeout is exceeded.
   *
   * @param ms - Timeout in milliseconds
   */
  withTimeout(ms: number): Procedure<THandler> {
    return createProcedureFromImpl<TArgs, THandler>(
      {
        name: this.procedureName,
        schema: this.schema,
        middleware: this.middlewares as unknown as (Middleware<any[]> | MiddlewarePipeline)[],
        handleFactory: this.handleFactory,
        sourceType: this.sourceType,
        sourceId: this.sourceId,
        metadata: this.metadata,
        timeout: ms,
        // Preserve execution tracking options (Phase 3)
        executionBoundary: this.executionBoundary,
        executionType: this.executionType,
        skipTracking: this.skipTracking,
      },
      this.handler!,
    );
  }

  /**
   * Create a procedure variant with merged metadata. Returns a new Procedure.
   * Metadata flows to ExecutionTracker and is included in procedure events and telemetry spans.
   *
   * @param metadata - Metadata to merge with existing procedure metadata
   */
  withMetadata(metadata: Record<string, unknown>): Procedure<THandler> {
    return createProcedureFromImpl<TArgs, THandler>(
      {
        name: this.procedureName,
        schema: this.schema,
        middleware: this.middlewares as unknown as (Middleware<any[]> | MiddlewarePipeline)[],
        handleFactory: this.handleFactory,
        sourceType: this.sourceType,
        sourceId: this.sourceId,
        // Merge metadata - new values override existing
        metadata: { ...this.metadata, ...metadata },
        timeout: this.timeout,
        // Preserve execution tracking options (Phase 3)
        executionBoundary: this.executionBoundary,
        executionType: this.executionType,
        skipTracking: this.skipTracking,
      },
      this.handler!,
    );
  }

  /**
   * Pipe the output of this procedure to another procedure.
   * Creates a new procedure that runs this procedure, then passes its result to the next.
   */
  pipe<TNext extends (arg: ExtractReturn<THandler>) => any>(
    next: Procedure<TNext>,
  ): Procedure<(...args: TArgs) => Promise<ExtractReturn<TNext>>> {
    const self = this;
    const pipedHandler = async (...args: TArgs): Promise<ExtractReturn<TNext>> => {
      const firstResult = await self.execute(args);
      // Access .result on the next procedure's return value since procedures return ExecutionHandle by default
      const secondResult = await (next as any)(firstResult).result;
      return secondResult;
    };

    return createProcedureFromImpl<TArgs, typeof pipedHandler>(
      {
        name: this.procedureName ? `${this.procedureName}.pipe` : "piped-procedure",
        sourceType: this.sourceType,
        sourceId: this.sourceId,
        metadata: this.metadata,
        timeout: this.timeout,
      },
      pipedHandler,
    ) as any;
  }
}

/**
 * Helper to create a callable Procedure from ProcedureImpl.
 * Returns Pass-through Procedure when handleFactory: false, otherwise Procedure.
 */
function createProcedureFromImpl<TArgs extends any[], THandler extends (...args: TArgs) => any>(
  options: ProcedureOptions & { handleFactory: false },
  handler?: THandler,
): Procedure<THandler, true>;
function createProcedureFromImpl<TArgs extends any[], THandler extends (...args: TArgs) => any>(
  options: ProcedureOptions,
  handler?: THandler,
): Procedure<THandler>;
function createProcedureFromImpl<TArgs extends any[], THandler extends (...args: TArgs) => any>(
  options: ProcedureOptions,
  handler?: THandler,
): Procedure<THandler> | Procedure<THandler, true> {
  const impl = new ProcedureImpl<TArgs, THandler>(options, handler);

  // Create a callable function
  const proc = (...args: any[]) => {
    // Support context as last arg (backward compat)
    let actualArgs: TArgs;

    if (args.length > 0) {
      const lastArg = args[args.length - 1];
      // Check if last arg is a KernelContext
      if (isKernelContext(lastArg)) {
        actualArgs = args.slice(0, -1) as TArgs;
      } else {
        actualArgs = args as TArgs;
      }
    } else {
      actualArgs = args as TArgs;
    }

    // Return result directly (pass-through) or ExecutionHandle
    return impl.exec(...actualArgs);
  };

  // Attach methods - same for both Procedure with handle return and Pass-through return Procedure
  (proc as any).use = impl.use.bind(impl);
  (proc as any).withContext = impl.withContext.bind(impl);
  (proc as any).withMiddleware = impl.withMiddleware.bind(impl);
  (proc as any).withTimeout = impl.withTimeout.bind(impl);
  (proc as any).withMetadata = impl.withMetadata.bind(impl);
  (proc as any).exec = impl.exec.bind(impl);
  (proc as any).pipe = impl.pipe.bind(impl);

  // Brand with symbol for deterministic type checking
  (proc as any)[PROCEDURE_SYMBOL] = true;

  return proc as unknown as Procedure<THandler> | Procedure<THandler, true>;
}

// ============================================================================
// Public API - Functions
// ============================================================================

/**
 * Helper to create a generator procedure that captures 'this' context.
 */
type Handler<TArgs extends any[]> =
  | ((...args: TArgs) => any)
  | ((this: any, ...args: TArgs) => any);

export function generatorProcedure<TThis, TArgs extends any[], THandler extends Handler<TArgs>>(
  optionsOrFn?: ProcedureOptions | THandler,
  fn?: THandler,
): Procedure<THandler> {
  if (typeof optionsOrFn === "function") {
    fn = optionsOrFn;
  }

  return createProcedure(function (this: TThis, ...args: TArgs) {
    if (!fn) {
      throw ValidationError.required(
        "handler",
        "Handler function required when options are provided",
      );
    }
    return fn.apply(this, args);
  } as THandler) as Procedure<THandler>;
}

/**
 * Create a Procedure from a function.
 *
 * By default, calling the procedure returns an ExecutionHandle.
 * Use `handleFactory: false` for pass-through mode where the handler's
 * return value is returned directly (useful for delegating to other procedures).
 *
 * @example Standard procedure (returns ExecutionHandle)
 * ```typescript
 * const greet = createProcedure(async (name: string) => `Hello, ${name}!`);
 * const handle = greet('World');  // ExecutionHandle
 * const result = await handle;    // "Hello, World!"
 * ```
 *
 * @example Pass-through procedure (returns handler result directly)
 * ```typescript
 * const run = createProcedure(
 *   { name: 'agentick:run', handleFactory: false },
 *   (element, input) => app.run(input)  // Returns SessionExecutionHandle
 * );
 * const handle = run(<jsx />, opts);  // SessionExecutionHandle directly
 * ```
 */
// Overload: handler only → Procedure
export function createProcedure<THandler extends (...args: any[]) => any>(
  handler: THandler,
): Procedure<THandler>;
// Overload: options with handleFactory: false → Pass-through Procedure
export function createProcedure<THandler extends (...args: any[]) => any>(
  options: ProcedureOptions & { handleFactory: false },
  handler: THandler,
): Procedure<THandler, true>;
// Overload: options without handleFactory: false → Procedure
export function createProcedure<THandler extends (...args: any[]) => any>(
  options: ProcedureOptions,
  handler: THandler,
): Procedure<THandler>;
// Implementation
export function createProcedure<THandler extends (...args: any[]) => any>(
  optionsOrFn?: ProcedureOptions | THandler,
  fn?: THandler,
): Procedure<THandler> | Procedure<THandler, true> {
  let options: ProcedureOptions = {};
  let handler: THandler | undefined;

  if (typeof optionsOrFn === "function") {
    handler = optionsOrFn;
    options = { sourceType: "procedure" };
  } else if (optionsOrFn) {
    options = { ...optionsOrFn, sourceType: "procedure" };
    if (!fn) {
      throw ValidationError.required(
        "handler",
        "Handler function required when options are provided",
      );
    }
    handler = fn;
  } else if (fn) {
    handler = fn;
    options = { sourceType: "procedure" };
  }

  if (!handler) {
    throw ValidationError.required("handler");
  }

  return createProcedureFromImpl<ExtractArgs<THandler>, THandler>(options, handler) as any;
}

/**
 * Pipe multiple procedures together, passing the output of each to the next.
 *
 * @example
 * ```typescript
 * const parse = createProcedure(async (json: string) => JSON.parse(json));
 * const validate = createProcedure(async (data: unknown) => schema.parse(data));
 * const transform = createProcedure(async (valid: Valid) => transform(valid));
 *
 * // Create a pipeline that parses, validates, then transforms
 * const pipeline = pipe(parse, validate, transform);
 * const result = await pipeline('{"name": "test"}');
 * ```
 */
export function pipe<T1 extends (...args: any[]) => any>(p1: Procedure<T1>): Procedure<T1>;
export function pipe<
  T1 extends (...args: any[]) => any,
  T2 extends (arg: ExtractReturn<T1>) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
): Procedure<(...args: ExtractArgs<T1>) => Promise<ExtractReturn<T2>>>;
export function pipe<
  T1 extends (...args: any[]) => any,
  T2 extends (arg: ExtractReturn<T1>) => any,
  T3 extends (arg: ExtractReturn<T2>) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
  p3: Procedure<T3>,
): Procedure<(...args: ExtractArgs<T1>) => Promise<ExtractReturn<T3>>>;
export function pipe<
  T1 extends (...args: any[]) => any,
  T2 extends (arg: ExtractReturn<T1>) => any,
  T3 extends (arg: ExtractReturn<T2>) => any,
  T4 extends (arg: ExtractReturn<T3>) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
  p3: Procedure<T3>,
  p4: Procedure<T4>,
): Procedure<(...args: ExtractArgs<T1>) => Promise<ExtractReturn<T4>>>;
export function pipe<
  T1 extends (...args: any[]) => any,
  T2 extends (arg: ExtractReturn<T1>) => any,
  T3 extends (arg: ExtractReturn<T2>) => any,
  T4 extends (arg: ExtractReturn<T3>) => any,
  T5 extends (arg: ExtractReturn<T4>) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
  p3: Procedure<T3>,
  p4: Procedure<T4>,
  p5: Procedure<T5>,
): Procedure<(...args: ExtractArgs<T1>) => Promise<ExtractReturn<T5>>>;
export function pipe(...procedures: Procedure<any>[]): Procedure<any> {
  if (procedures.length === 0) {
    throw new ValidationError("pipe requires at least one procedure", "procedures");
  }
  if (procedures.length === 1) {
    return procedures[0];
  }

  // Chain all procedures together using the instance pipe method
  let result = procedures[0];
  for (let i = 1; i < procedures.length; i++) {
    result = result.pipe(procedures[i]);
  }
  return result;
}

/**
 * Compose multiple procedures into a single procedure (right-to-left execution).
 * This is the functional programming convention: compose(a, b, c)(x) = a(b(c(x)))
 *
 * For left-to-right execution, use `pipe()` instead.
 *
 * @example
 * ```typescript
 * const format = createProcedure((s: string) => s.toUpperCase());
 * const validate = createProcedure((s: string) => s.trim());
 * const parse = createProcedure((input: string) => input);
 *
 * // compose executes right-to-left: parse -> validate -> format
 * const pipeline = compose(format, validate, parse);
 * const result = await pipeline('  hello  '); // "HELLO"
 * ```
 */
export function compose<T1 extends (...args: any[]) => any>(p1: Procedure<T1>): Procedure<T1>;
export function compose<
  T1 extends (arg: ExtractReturn<T2>) => any,
  T2 extends (...args: any[]) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
): Procedure<(...args: ExtractArgs<T2>) => Promise<ExtractReturn<T1>>>;
export function compose<
  T1 extends (arg: ExtractReturn<T2>) => any,
  T2 extends (arg: ExtractReturn<T3>) => any,
  T3 extends (...args: any[]) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
  p3: Procedure<T3>,
): Procedure<(...args: ExtractArgs<T3>) => Promise<ExtractReturn<T1>>>;
export function compose<
  T1 extends (arg: ExtractReturn<T2>) => any,
  T2 extends (arg: ExtractReturn<T3>) => any,
  T3 extends (arg: ExtractReturn<T4>) => any,
  T4 extends (...args: any[]) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
  p3: Procedure<T3>,
  p4: Procedure<T4>,
): Procedure<(...args: ExtractArgs<T4>) => Promise<ExtractReturn<T1>>>;
export function compose<
  T1 extends (arg: ExtractReturn<T2>) => any,
  T2 extends (arg: ExtractReturn<T3>) => any,
  T3 extends (arg: ExtractReturn<T4>) => any,
  T4 extends (arg: ExtractReturn<T5>) => any,
  T5 extends (...args: any[]) => any,
>(
  p1: Procedure<T1>,
  p2: Procedure<T2>,
  p3: Procedure<T3>,
  p4: Procedure<T4>,
  p5: Procedure<T5>,
): Procedure<(...args: ExtractArgs<T5>) => Promise<ExtractReturn<T1>>>;
export function compose(...procedures: Procedure<any>[]): Procedure<any> {
  if (procedures.length === 0) {
    throw new ValidationError("compose requires at least one procedure", "procedures");
  }
  if (procedures.length === 1) {
    return procedures[0];
  }

  // Chain in reverse order: compose(a, b, c) = a(b(c(x)))
  // Start from the end and work backwards
  let result = procedures[procedures.length - 1];
  for (let i = procedures.length - 2; i >= 0; i--) {
    result = result.pipe(procedures[i]);
  }
  return result;
}

/**
 * Create a Hook Procedure from a function.
 *
 * @example
 * ```typescript
 * const processChunk = createHook(async (chunk: string) => chunk.toUpperCase());
 * // Type inferred: Procedure<[string], string>
 * ```
 */
export function createHook<THandler extends (...args: any[]) => any>(
  handler: THandler,
): Procedure<THandler>;
export function createHook<THandler extends (...args: any[]) => any>(
  options: ProcedureOptions,
  handler: THandler,
): Procedure<THandler>;
export function createHook<THandler extends (...args: any[]) => any>(
  optionsOrFn?: ProcedureOptions | THandler,
  fn?: THandler,
): Procedure<THandler> {
  let options: ProcedureOptions = {};
  let handler: THandler | undefined;

  if (typeof optionsOrFn === "function") {
    handler = optionsOrFn;
    options = { sourceType: "hook" };
  } else if (optionsOrFn) {
    options = { ...optionsOrFn, sourceType: "hook" };
    if (!fn) {
      throw ValidationError.required(
        "handler",
        "Handler function required when options are provided",
      );
    }
    handler = fn;
  } else if (fn) {
    handler = fn;
    options = { sourceType: "hook" };
  }

  if (!handler) {
    throw ValidationError.required("handler");
  }

  return createProcedure(options, handler);
}

// ============================================================================
// ProcedureBase - Base class for auto-wrapping methods as Procedures
// ============================================================================
// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Type-safe helper to apply middleware to a Procedure while preserving types.
 *
 * This helper ensures that middleware types are correctly matched to the Procedure's
 * argument types, avoiding the need for type assertions.
 *
 * @example
 * ```typescript
 * const proc = createProcedure({ name: 'test' }, async (input: string) => input);
 * const middleware: Middleware<[string]>[] = [...];
 * const procWithMw = applyMiddleware(proc, middleware);
 * // procWithMw is still Procedure<[string], string> - types preserved!
 * ```
 */
export function applyMiddleware<TArgs extends any[], TOutput>(
  procedure: Procedure<(...args: TArgs) => TOutput>,
  ...middleware: (Middleware<TArgs> | MiddlewarePipeline)[]
): Procedure<(...args: TArgs) => TOutput> {
  return procedure.use(...middleware);
}

/**
 * Type-safe helper to apply middleware from a registry/hook system.
 *
 * This is useful when middleware comes from hook registries where types might
 * be unions or `Middleware<any[]>`. The helper ensures type safety by requiring
 * the middleware to match the Procedure's argument types.
 *
 * @example
 * ```typescript
 * const proc = createProcedure({ name: 'test' }, async (input: string) => input);
 * const registryMiddleware = registry.getMiddleware('test'); // Middleware<any[]>[]
 * const procWithMw = applyRegistryMiddleware(proc, registryMiddleware);
 * // Types are preserved and validated
 * ```
 */
export function applyRegistryMiddleware<THandler extends (...args: any[]) => any>(
  procedure: Procedure<THandler>,
  ...middleware: (Middleware<any[]> | MiddlewarePipeline)[]
): Procedure<THandler> {
  // Type assertion is safe here because we're applying middleware that should
  // be compatible with the Procedure's args. The runtime will validate.
  // We accept Procedure<any, any> to handle cases where createEngineProcedure
  // returns a generic Procedure type that needs to be narrowed.
  return (procedure as Procedure<THandler>).use(
    ...(middleware as (Middleware<ExtractArgs<THandler>> | MiddlewarePipeline)[]),
  );
}

export function wrapProcedure(middleware: Middleware<any[]>[]) {
  function wrapProcedureImpl<THandler extends (...args: any[]) => any>(
    handler: THandler,
  ): Procedure<THandler>;
  function wrapProcedureImpl<THandler extends (...args: any[]) => any>(
    config: ProcedureOptions,
    handler: THandler,
  ): Procedure<THandler>;
  function wrapProcedureImpl<THandler extends (...args: any[]) => any>(
    optionsOrFn?: ProcedureOptions | THandler,
    fn?: THandler,
  ): Procedure<THandler> {
    let config: ProcedureOptions;
    let handler: THandler;

    if (typeof optionsOrFn === "function") {
      // Handler-only overload: createEngineProcedure(handler)
      handler = optionsOrFn;
      config = {
        name: handler.name || "anonymous",
      };
    } else if (optionsOrFn) {
      // Config + handler overload: createEngineProcedure(config, handler)
      config = { ...optionsOrFn };
      if (!fn) {
        throw ValidationError.required(
          "handler",
          "Handler function required when options are provided",
        );
      }
      handler = fn;
    } else if (fn) {
      // Edge case: just handler as second param
      handler = fn;
      config = {
        name: handler.name || "anonymous",
      };
    } else {
      throw ValidationError.required("handler");
    }

    // Merge middleware: engine defaults + global + config middleware
    config.middleware = [...middleware, ...(config.middleware || [])];

    return createProcedure<THandler>(config, handler);
  }

  return wrapProcedureImpl;
}

export function wrapHook(middleware: Middleware<any[]>[]) {
  function wrapHookImpl<THandler extends (...args: any[]) => any>(
    handler: THandler,
  ): Procedure<THandler>;
  function wrapHookImpl<THandler extends (...args: any[]) => any>(
    config: ProcedureOptions,
    handler: THandler,
  ): Procedure<THandler>;
  function wrapHookImpl<THandler extends (...args: any[]) => any>(
    optionsOrFn?: ProcedureOptions | THandler,
    fn?: THandler,
  ): Procedure<THandler> {
    let config: ProcedureOptions;
    let handler: THandler;

    if (typeof optionsOrFn === "function") {
      // Handler-only overload: createEngineHook(handler)
      handler = optionsOrFn;
      config = {
        name: handler.name || "anonymous",
      };
    } else if (optionsOrFn) {
      // Config + handler overload: createEngineHook(config, handler)
      config = { ...optionsOrFn };
      if (!fn) {
        throw ValidationError.required(
          "handler",
          "Handler function required when options are provided",
        );
      }
      handler = fn;
    } else if (fn) {
      // Edge case: just handler as second param
      handler = fn;
      config = {
        name: handler.name || "anonymous",
      };
    } else {
      throw ValidationError.required("handler");
    }

    // Merge middleware: engine defaults + global + config middleware
    config.middleware = [...middleware, ...(config.middleware || [])];

    return createHook<THandler>(config, handler);
  }

  return wrapHookImpl;
}
