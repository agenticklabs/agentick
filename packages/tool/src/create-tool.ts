/**
 * `createTool` — generic, reconciler-agnostic tool authoring.
 *
 * Returns a `ToolRegistration` + handler + validator bundle that
 * drops directly into any `HandlerResolver.register(...)` +
 * `ToolExecutorHarness.register(...)` pair. Zero render-time
 * concerns; no React hooks; no DI plumbing.
 *
 * Tools that need tree-scoped context (sandbox, MCP connection,
 * provided services) use a reconciler-specific factory layered on
 * top of this one — e.g., `createTool` in `@agentick/reconciler-react`
 * adds a `use()` hook slot that captures React-Context-derived deps
 * during the reconciler's collect walk.
 *
 * Depends only on `@agentick/spec` — peer of `@agentick/tool-executor`,
 * not consumer of it. The authoring layer doesn't pull the runtime.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type {
  ContentBlock,
  JsonSchema,
  StandardSchemaV1,
  ToolAnnotations,
  ToolDeclaration,
  ToolExposure,
  ToolHandler,
  ToolHandlerCtx,
  Validator,
} from "@agentick/spec";

import { fromStandardSchema, permissiveValidator } from "./validator.js";

// ============================================================================
// Spec
// ============================================================================

export interface ToolSpec<TInput = unknown> {
  /** Tool name. Used as the registry key and as the model-facing identifier. */
  readonly name: string;
  /** Human-readable description. Surfaced to the model in the tool list. */
  readonly description: string;
  /**
   * JSON Schema describing the tool's input shape. This is what's
   * sent to the model. For ergonomic typing, pair with `input`
   * (Standard Schema) to drive runtime validation; the JSON Schema is
   * for the model's typed function-calling protocol.
   *
   * Defaults to `{ type: "object" }` when omitted.
   */
  readonly inputSchema?: JsonSchema;
  /**
   * Optional Standard-Schema-compliant validator (Zod, Valibot,
   * ArkType, Effect Schema, etc) run against the dispatched input
   * before the handler executes. When the validator rejects, the
   * harness fails with `ToolValidationError`.
   *
   * When omitted, `permissiveValidator` is used — input flows through
   * unchecked.
   */
  readonly input?: StandardSchemaV1<TInput>;
  /**
   * The async function invoked at dispatch time. Receives the
   * validated input + a `ctx` bundle (toolCallId, sessionId,
   * executionId, abort signal, channel emit).
   */
  readonly handler: (
    input: TInput,
    args: { readonly ctx: ToolHandlerCtx },
  ) => Promise<readonly ContentBlock[]>;
  /**
   * Where the tool is reachable from. Defaults to `["model"]`.
   *   - `"model"` — model-callable via function-calling
   *   - `"dispatch"` — host-callable via `session.dispatch(name, input)`
   *   - `"runtime"` — internal-only
   */
  readonly exposure?: readonly ToolExposure[];
  /** Annotations: requiresConfirmation, timeout, intent, etc. */
  readonly annotations?: ToolAnnotations;
  /** Arbitrary metadata attached to the declaration. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Override the auto-generated `handlerRef`. Useful when paired with
   * an external resolver that already knows the ref.
   */
  readonly handlerRef?: string;
}

// ============================================================================
// Output
// ============================================================================

/**
 * Bundle returned by `createTool`. Each field maps to one thing the
 * tool executor needs:
 *
 *   - `declaration` → `ToolExecutorHarness.register({ registration })`
 *   - `handlerRef` + `handler` + `validator` →
 *     `HandlerResolver.register(handlerRef, handler, validator)`
 */
export interface CreatedTool {
  readonly declaration: ToolDeclaration;
  readonly handlerRef: string;
  readonly handler: ToolHandler;
  readonly validator: Validator;
}

// ============================================================================
// createTool
// ============================================================================

let autoCounter = 0;

export function createTool<TInput = unknown>(spec: ToolSpec<TInput>): CreatedTool {
  const handlerRef = spec.handlerRef ?? `tool:${spec.name}:${++autoCounter}`;

  const declaration: ToolDeclaration = {
    id: spec.name,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema ?? { type: "object" },
    exposure: spec.exposure ?? ["model"],
    handlerRef,
    ...(spec.annotations !== undefined ? { annotations: spec.annotations } : {}),
    ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
  };

  const handler: ToolHandler = async (input, { ctx }) => {
    return spec.handler(input as TInput, { ctx });
  };

  const validator: Validator = spec.input ? fromStandardSchema(spec.input) : permissiveValidator;

  return { declaration, handlerRef, handler, validator };
}
