/**
 * # Tentickle Kernel
 *
 * Low-level execution primitives for the Tentickle framework. The kernel provides
 * the foundational infrastructure that all other Tentickle packages build upon.
 *
 * ## Core Primitives
 *
 * - **Procedures** - Async function wrappers with middleware, context, and telemetry
 * - **Context** - Request-scoped state with automatic propagation
 * - **Channels** - Async generators for streaming with backpressure
 * - **Telemetry** - Execution tracking, spans, and metrics
 * - **Logger** - Structured logging with configurable levels
 *
 * ## When to Use Kernel Directly
 *
 * Most applications should use the higher-level `tentickle` package. Use kernel directly when:
 *
 * - Building custom execution infrastructure
 * - Creating new Tentickle adapters or integrations
 * - Need fine-grained control over procedure execution
 *
 * ## Example
 *
 * ```typescript
 * import { createProcedure, Context } from './core';
 *
 * const myProcedure = createProcedure(
 *   { name: 'my-operation' },
 *   async (input: string) => {
 *     return { result: input.toUpperCase() };
 *   }
 * );
 *
 * const result = await myProcedure.exec('hello');
 * ```
 *
 * @see {@link Procedure} - The core procedure abstraction
 * @see {@link KernelContext} - Request-scoped context
 * @see {@link Channel} - Streaming primitive
 * @see {@link Telemetry} - Execution tracking
 *
 * @module @tentickle/kernel
 */

export * from "./context";
export * from "./telemetry";
export * from "./otel-provider";
export * from "./procedure-graph";
export * from "./execution-tracker";
export * from "./execution-helpers";
export * from "./metrics-helpers";
export * from "./stream";
export * from "./channel";
export * from "./channel-helpers";
export * from "./procedure";
export * from "./logger";
export * from "./event-buffer";
export * from "./schema";
