/**
 * # Agentick Kernel
 *
 * Low-level execution primitives for the Agentick framework. The kernel provides
 * the foundational infrastructure that all other Agentick packages build upon.
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
 * Most applications should use the higher-level `agentick` package. Use kernel directly when:
 *
 * - Building custom execution infrastructure
 * - Creating new Agentick adapters or integrations
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
 * @module @agentick/kernel
 */

export * from "./context.js";
export * from "./telemetry.js";
export * from "./otel-provider.js";
export * from "./procedure-graph.js";
export * from "./execution-tracker.js";
export * from "./execution-helpers.js";
export * from "./metrics-helpers.js";
export * from "./stream.js";
export * from "./channel.js";
export * from "./channel-helpers.js";
export * from "./procedure.js";
export * from "./logger.js";
export * from "./event-buffer.js";
export * from "./schema.js";
export * from "./guard.js";

// Re-export guard errors from shared (guards are a procedure concept)
export { GuardError, isGuardError } from "@agentick/shared";
