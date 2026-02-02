/**
 * Execution Helpers
 *
 * Utilities for understanding execution context - whether an execution
 * is standalone, nested, what originated it, etc.
 *
 * Useful for persistence, logging, and conditional behavior based on
 * execution hierarchy.
 */

import { Context, type KernelContext } from "./context";
import { ExecutionTracker } from "./execution-tracker";
import type { ProcedureNode } from "./procedure-graph";

/**
 * Check if this is a standalone (root) execution or nested within another.
 *
 * @example
 * ```typescript
 * if (isStandaloneExecution(ctx)) {
 *   // Create new execution record
 * } else {
 *   // Link to parent execution
 * }
 * ```
 */
export function isStandaloneExecution(ctx: KernelContext): boolean {
  return !ctx.procedureNode?.parentPid;
}

/**
 * Check if this execution is nested within another procedure.
 * Opposite of isStandaloneExecution.
 */
export function isNestedExecution(ctx: KernelContext): boolean {
  return !!ctx.procedureNode?.parentPid;
}

/**
 * Get the name of the procedure that originated this execution chain.
 * Returns the origin's name if nested, or current procedure name if standalone.
 *
 * @example
 * ```typescript
 * const origin = getOriginName(ctx);
 * // 'engine:stream', 'engine:execute', 'model:generate', etc.
 * ```
 */
export function getOriginName(ctx: KernelContext): string | undefined {
  return ctx.origin?.name ?? ctx.procedureNode?.name;
}

/**
 * Get the origin procedure node if this is a nested execution.
 * Returns undefined for standalone executions.
 */
export function getOriginNode(ctx: KernelContext): ProcedureNode | undefined {
  return ctx.origin;
}

/**
 * Check if this execution is within an engine execution (engine:execute or engine:stream).
 * Useful for persistence to know if engine is handling top-level tracking.
 *
 * @example
 * ```typescript
 * if (isWithinEngine(ctx)) {
 *   // Engine handles execution record - just track model-specific stuff
 * } else {
 *   // Standalone model call - need full tracking
 * }
 * ```
 */
export function isWithinEngine(ctx: KernelContext): boolean {
  if (!ctx.procedureGraph || !ctx.procedurePid) {
    return false;
  }

  return ctx.procedureGraph.hasAncestor(
    ctx.procedurePid,
    (node) => node.name?.startsWith("engine:") ?? false,
  );
}

/**
 * Check if this execution has an ancestor with a specific procedure name.
 *
 * @example
 * ```typescript
 * if (hasAncestorNamed(ctx, 'engine:stream')) {
 *   // We're inside a streaming execution
 * }
 * ```
 */
export function hasAncestorNamed(ctx: KernelContext, name: string): boolean {
  if (!ctx.procedureGraph || !ctx.procedurePid) {
    return false;
  }

  return ctx.procedureGraph.hasAncestorWithName(ctx.procedurePid, name);
}

/**
 * Check if this execution has an ancestor matching a predicate.
 *
 * @example
 * ```typescript
 * if (hasAncestorMatching(ctx, n => n.metadata?.type === 'agent')) {
 *   // We're inside an agent execution
 * }
 * ```
 */
export function hasAncestorMatching(
  ctx: KernelContext,
  predicate: (node: ProcedureNode) => boolean,
): boolean {
  if (!ctx.procedureGraph || !ctx.procedurePid) {
    return false;
  }

  return ctx.procedureGraph.hasAncestor(ctx.procedurePid, predicate);
}

/**
 * Get the parent procedure node if one exists.
 */
export function getParentNode(ctx: KernelContext): ProcedureNode | undefined {
  return ctx.procedureNode?.getParentNode();
}

/**
 * Get the parent procedure's PID if one exists.
 */
export function getParentPid(ctx: KernelContext): string | undefined {
  return ctx.procedureNode?.parentPid;
}

/**
 * Get the root procedure ID (the origin of this execution chain).
 * Returns current PID if this is a standalone execution.
 */
export function getRootPid(ctx: KernelContext): string | undefined {
  return ctx.origin?.pid ?? ctx.procedurePid;
}

/**
 * Get execution hierarchy info - useful for logging and persistence.
 *
 * @example
 * ```typescript
 * const info = getExecutionInfo(ctx);
 * // {
 * //   pid: 'abc-123',
 * //   parentPid: 'def-456',
 * //   rootPid: 'ghi-789',
 * //   name: 'model:generate',
 * //   originName: 'engine:stream',
 * //   isStandalone: false,
 * //   isWithinEngine: true,
 * //   depth: 2
 * // }
 * ```
 */
export function getExecutionInfo(ctx: KernelContext): {
  pid: string | undefined;
  parentPid: string | undefined;
  rootPid: string | undefined;
  name: string | undefined;
  originName: string | undefined;
  isStandalone: boolean;
  isWithinEngine: boolean;
  depth: number;
} {
  // Calculate depth by traversing up
  let depth = 0;
  let current = ctx.procedureNode;
  while (current?.parentPid) {
    depth++;
    current = current.getParentNode();
  }

  return {
    pid: ctx.procedurePid,
    parentPid: ctx.procedureNode?.parentPid,
    rootPid: getRootPid(ctx),
    name: ctx.procedureNode?.name,
    originName: getOriginName(ctx),
    isStandalone: isStandaloneExecution(ctx),
    isWithinEngine: isWithinEngine(ctx),
    depth,
  };
}

/**
 * Options for withExecution helper.
 */
export interface WithExecutionOptions {
  /**
   * Human-readable name for this execution (shown in DevTools).
   */
  name: string;

  /**
   * Execution type for categorization (e.g., 'summarization', 'validation').
   * Shown as a badge in DevTools.
   * @default 'custom'
   */
  type?: string;

  /**
   * Additional metadata to attach to the execution.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Create a named execution boundary around an operation.
 *
 * Use this to mark semantically meaningful operations that should appear
 * as distinct executions in DevTools. The execution will be linked as a
 * child of the current execution (if any).
 *
 * @example
 * ```typescript
 * // Simple usage with just a name
 * const summary = await withExecution("Summarize Context", async () => {
 *   return model.generate(summarizePrompt);
 * });
 *
 * // With options
 * const result = await withExecution({
 *   name: "Validate Response",
 *   type: "validation",
 *   metadata: { validator: "schema" },
 * }, async () => {
 *   return validateSchema(response);
 * });
 *
 * // In a hook
 * onAfterCompile: async (ctx) => {
 *   await withExecution("Context Compaction", async () => {
 *     const summary = await model.generate(compactPrompt);
 *     ctx.updateContext(summary);
 *   });
 * }
 * ```
 *
 * @param nameOrOptions - Execution name string or options object
 * @param fn - The async function to execute within this boundary
 * @returns The result of the function
 */
export async function withExecution<T>(
  nameOrOptions: string | WithExecutionOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const options: WithExecutionOptions =
    typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;

  const { name, type = "custom", metadata } = options;

  // ExecutionTracker.track with 'child' boundary automatically:
  // - Links to parent procedure via ctx.procedurePid
  // - Links to parent execution via ctx.executionId
  // - Creates new executionId for this boundary
  // - Uses Context.fork() internally for isolation
  return ExecutionTracker.track(
    Context.tryGet() ?? Context.create(),
    {
      name,
      metadata: { ...metadata, type },
      executionBoundary: "child",
      executionType: type,
    },
    async () => fn(),
  );
}
