import { Context, type KernelContext } from "./context";
import type { ProcedureNode } from "./procedure-graph";
import { ProcedureGraph, type ProcedureStatus } from "./procedure-graph";
import { Telemetry } from "./telemetry";
import { AbortError } from "@agentick/shared";
import { isAsyncIterable } from "./stream";

/**
 * Brand symbol for ExecutionHandle objects.
 *
 * ExecutionTracker uses this to distinguish handles (which are AsyncIterable
 * but manage their own lifecycle) from pure async generators (where iteration
 * IS the execution). Branded objects pass through the tracker without wrapping.
 */
export const ExecutionHandleBrand: unique symbol = Symbol("agentick.execution-handle");

/**
 * Execution boundary behavior configuration.
 *
 * - `'always'`: Always create a new root execution (no parentExecutionId)
 * - `'child'`: Always create a new child execution (with parentExecutionId from current context)
 * - `'auto'`: Create only if not already in an execution (default behavior)
 * - `false`: Never create an execution boundary, inherit from parent
 */
export type ExecutionBoundaryConfig = "always" | "child" | "auto" | false;

export interface ExecutionTrackerOptions {
  name?: string;
  metadata?: Record<string, any>;
  parentPid?: string;
  /**
   * Explicit execution ID to use if this becomes a boundary.
   * If not provided, procedurePid is used as the executionId.
   * Useful for Engine to correlate with ExecutionHandle.pid.
   */
  executionId?: string;

  /**
   * Declarative execution boundary configuration.
   *
   * - `'always'`: Always create a new root execution (engine:execute, engine:stream)
   * - `'child'`: Always create a new child execution (component_tool, harness)
   * - `'auto'`: Create only if not already in an execution (model:generate, model:stream)
   * - `false`: Never create an execution boundary (compile:tick, internal procedures)
   *
   * @default 'auto'
   */
  executionBoundary?: ExecutionBoundaryConfig;

  /**
   * Explicit execution type (e.g., 'engine', 'model', 'component_tool', 'harness').
   * If not provided, derived from procedure name.
   */
  executionType?: string;
}

/**
 * Unified execution tracker for procedures and hooks.
 * Handles automatic telemetry, metrics tracking, and propagation.
 */
export class ExecutionTracker {
  /**
   * Track a procedure/hook execution with automatic telemetry and metrics
   */
  static async track<T>(
    ctx: KernelContext,
    options: ExecutionTrackerOptions,
    fn: (node: ProcedureNode) => Promise<T>,
  ): Promise<T> {
    // Initialize graph if needed
    if (!ctx.procedureGraph) {
      ctx.procedureGraph = new ProcedureGraph();
    }

    const procedurePid = crypto.randomUUID();
    const parentPid = options.parentPid || ctx.procedurePid;
    const effectiveName = options.name || "anonymous";

    // Determine origin: if this is a root procedure (no parent), origin is undefined
    // Otherwise, use existing origin or find root node
    let origin: ProcedureNode | undefined;
    if (!parentPid) {
      // This is the root procedure - origin is undefined (it IS the origin)
      origin = undefined;
    } else {
      // Use existing origin if set, otherwise find root node
      origin = ctx.origin;
      if (!origin && ctx.procedureGraph) {
        const rootNode = ctx.procedureGraph.getRoot();
        origin = rootNode;
      }
    }

    // Determine execution context (boundary detection)
    // Use declarative executionBoundary config to decide behavior
    const boundaryConfig = options.executionBoundary ?? "auto";

    // Get current execution context from context (Phase 3 fields)
    const currentExecutionId = ctx.executionId;
    const contextHandlePid = (ctx.executionHandle as { pid?: string } | undefined)?.pid;

    let executionId: string | undefined;
    let isExecutionBoundary: boolean;
    let executionType: string | undefined;
    let parentExecutionId: string | undefined;

    switch (boundaryConfig) {
      case "always":
        // Always create a new execution
        // If ctx.parentExecutionId is set (e.g., from child execution), use it for child linking
        // Otherwise, this is a root execution with no parent
        executionId = options.executionId ?? contextHandlePid ?? procedurePid;
        isExecutionBoundary = true;
        // Use ctx.executionType (set by engine); fall back to options or derive from name
        executionType =
          ctx.executionType ??
          options.executionType ??
          (effectiveName.includes(":") ? effectiveName.split(":")[0] : effectiveName);
        parentExecutionId = ctx.parentExecutionId; // May be undefined for true roots
        break;

      case "child":
        // Always create a new child execution (with parentExecutionId)
        executionId = options.executionId ?? procedurePid;
        isExecutionBoundary = true;
        // Use ctx.executionType (set by engine); fall back to options or derive from name
        executionType =
          ctx.executionType ??
          options.executionType ??
          (effectiveName.includes(":") ? effectiveName.split(":")[0] : effectiveName);
        // Parent is the current execution from context
        parentExecutionId = currentExecutionId;
        break;

      case "auto":
        // Create only if not already in an execution
        if (currentExecutionId) {
          // Already in an execution - inherit
          executionId = currentExecutionId;
          isExecutionBoundary = false;
          executionType = undefined;
          parentExecutionId = undefined; // Not applicable, inheriting
        } else {
          // Not in an execution - create new root
          executionId = options.executionId ?? contextHandlePid ?? procedurePid;
          isExecutionBoundary = true;
          executionType =
            options.executionType ??
            (effectiveName.includes(":") ? effectiveName.split(":")[0] : effectiveName);
          parentExecutionId = undefined; // Root execution
        }
        break;

      case false:
        // Never create an execution boundary - inherit from context (may be undefined)
        executionId = currentExecutionId;
        isExecutionBoundary = false;
        executionType = undefined;
        parentExecutionId = undefined;
        break;
    }

    // Register procedure with execution context
    const node = ctx.procedureGraph.register(
      procedurePid,
      parentPid,
      effectiveName,
      options.metadata,
      executionId,
      isExecutionBoundary,
      executionType,
    );

    // Start telemetry span
    const span = Telemetry.startSpan(effectiveName);
    span.setAttribute("procedure.pid", procedurePid);
    span.setAttribute("procedure.execution_id", executionId);
    if (isExecutionBoundary) {
      span.setAttribute("procedure.is_execution_boundary", true);
      if (executionType) {
        span.setAttribute("procedure.execution_type", executionType);
      }
    }
    if (parentPid) {
      span.setAttribute("procedure.parent_pid", parentPid);
    }
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        span.setAttribute(`procedure.metadata.${key}`, value);
      }
    }

    // Create a new metrics object for this procedure's scope
    // This prevents child procedures from modifying parent's metrics directly
    const procedureMetrics: Record<string, number> = {};

    // Create metrics proxy that writes to both procedure scope and node
    // This allows existing code to write to ctx.metrics and it automatically tracks in node
    const metricsProxy = new Proxy(procedureMetrics, {
      set(target, key: string, value: number) {
        const oldValue = target[key] || 0;
        target[key] = value;
        // Accumulate delta in node
        const delta = value - oldValue;
        if (delta !== 0) {
          node.addMetric(key, delta);
        }
        return true;
      },
      get(target, key: string) {
        // Return value from procedure scope
        return target[key] || 0;
      },
      ownKeys(target) {
        return Object.keys(target);
      },
      has(target, key: string) {
        return key in target;
      },
      getOwnPropertyDescriptor(target, key: string) {
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });

    // Use Context.fork to create an isolated child context for this procedure.
    // This prevents race conditions when parallel procedures run - each gets its own
    // context object with its own procedurePid, procedureNode, origin, and metrics.
    // Shared state (events, procedureGraph, channels, signal) is still accessible.
    //
    // If this is an execution boundary, set the execution fields in the forked context.
    // This ensures all nested procedures inherit executionId from context.
    return Context.fork(
      {
        procedurePid,
        procedureNode: node,
        origin,
        metrics: metricsProxy as Record<string, number>,
        // Execution context (Phase 3): set if boundary, otherwise inherit from parent context
        ...(isExecutionBoundary
          ? {
              executionId,
              executionType,
              parentExecutionId,
            }
          : {}),
      },
      async () => {
        try {
          // Check abort before starting
          if (ctx.signal?.aborted) {
            node.cancel();
            const abortError = new AbortError();
            span.recordError(abortError);
            span.end();
            throw abortError;
          }

          // Emit start event with execution context
          Context.emit("procedure:start", {
            pid: procedurePid,
            name: effectiveName,
            parentPid,
            executionId: node.executionId,
            isExecutionBoundary: node.isExecutionBoundary,
            executionType: node.executionType,
            parentExecutionId, // For DevTools execution tree linking
          });

          // Execute function
          const result = await fn(node);

          // If result is a pure AsyncIterable (not a branded ExecutionHandle), wrap it
          // to maintain context and defer procedure:end until iteration completes.
          // ExecutionHandles manage their own lifecycle — pass them through unchanged.
          if (isAsyncIterable(result) && !(result as any)[ExecutionHandleBrand]) {
            // Capture the forked context for use during iteration
            const forkedContext = Context.get();

            const wrappedIterable = (async function* () {
              const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
              try {
                while (true) {
                  // Run iterator.next() inside the forked context to maintain procedurePid
                  const next = await Context.run(forkedContext, async () => iterator.next());

                  if (next.done) break;

                  // Check abort after getting next value but before yielding
                  // This allows the producer to call abort() between yields
                  if (ctx.signal?.aborted) {
                    throw new AbortError();
                  }

                  // Emit stream:chunk event for consumers listening to the handle
                  // The value is emitted directly (not wrapped) - it's typically an engine event
                  await Context.run(forkedContext, async () => {
                    Context.emit("stream:chunk", next.value);
                  });

                  yield next.value;
                }

                // Completed successfully - update status and emit end
                ctx.procedureGraph!.updateStatus(procedurePid, "completed");
                ExecutionTracker.sendMetricsToTelemetry(node, span);
                span.end();
                await Context.run(forkedContext, async () => {
                  Context.emit("procedure:end", {
                    pid: procedurePid,
                    executionId: node.executionId,
                    metrics: node.metrics,
                    durationMs: node.durationMs,
                  });
                });
              } catch (error) {
                // Handle errors during iteration
                const isAbort =
                  (error as Error)?.name === "AbortError" ||
                  (error as Error)?.message?.includes("aborted");
                const status: ProcedureStatus = isAbort ? "cancelled" : "failed";
                ctx.procedureGraph!.updateStatus(procedurePid, status, error as Error);
                span.recordError(error);
                ExecutionTracker.sendMetricsToTelemetry(node, span);
                span.end();
                await Context.run(forkedContext, async () => {
                  Context.emit("procedure:error", {
                    pid: procedurePid,
                    executionId: node.executionId,
                    error,
                  });
                });
                throw error;
              } finally {
                // Clean up iterator if it has a return method
                if (iterator.return) {
                  await Context.run(forkedContext, async () => iterator.return!());
                }
              }
            })();

            return wrappedIterable as T;
          }

          // Regular (non-AsyncIterable) result - complete immediately
          ctx.procedureGraph!.updateStatus(procedurePid, "completed");
          this.sendMetricsToTelemetry(node, span);
          span.end();
          Context.emit("procedure:end", {
            pid: procedurePid,
            executionId: node.executionId,
            result,
            metrics: node.metrics,
            durationMs: node.durationMs,
          });

          return result;
        } catch (error) {
          // Determine if it was an abort
          const isAbort =
            (error as Error)?.name === "AbortError" ||
            (error as Error)?.message?.includes("aborted");

          // Update status
          const status: ProcedureStatus = isAbort ? "cancelled" : "failed";
          ctx.procedureGraph!.updateStatus(procedurePid, status, error as Error);

          span.recordError(error);
          this.sendMetricsToTelemetry(node, span);
          span.end();

          Context.emit("procedure:error", {
            pid: procedurePid,
            executionId: node.executionId,
            error,
          });

          // Preserve error name and message
          const err = error as Error;
          if (isAbort && err.name !== "AbortError") {
            err.name = "AbortError";
          }
          throw err;
        }
        // No finally needed - Context.fork handles isolation automatically
        // Parent context is never modified, so no restoration required
      },
    );
  }

  /**
   * Send metrics to telemetry system
   */
  private static sendMetricsToTelemetry(node: ProcedureNode, span: any): void {
    for (const [key, value] of Object.entries(node.metrics)) {
      Telemetry.getHistogram(`procedure.${key}`).record(value, {
        procedure: node.name || "anonymous",
        procedure_pid: node.pid,
        status: node.status,
      });

      span.setAttribute(`metrics.${key}`, value);
    }
  }
}
