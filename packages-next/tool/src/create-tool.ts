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
 * top of this one — e.g., `createTool` in `@agentick/reconciler-react-next`
 * adds a `use()` hook slot that captures React-Context-derived deps
 * during the reconciler's collect walk.
 *
 * Depends only on `@agentick/spec-next` — peer of `@agentick/tool-executor-next`,
 * not consumer of it. The authoring layer doesn't pull the runtime.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type {
  StandardSchemaV1,
  ToolAnnotations,
  ToolDeclaration,
  ToolExposure,
  ToolHandler,
  ToolHandlerCtx,
  ToolHandlerResult,
  Validator,
} from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { fromStandardSchema, permissiveValidator } from "./validator.js";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// Spec
// ============================================================================

export interface ToolSpec<TInput = unknown> {
  /** Tool name. Used as the registry key and as the model-facing identifier. */
  readonly name: string;
  /** Human-readable description. Surfaced to the model in the tool list. */
  readonly description: string;
  /**
   * Input schema. Accepts any Standard-Schema-compliant validator
   * (Zod 4, Valibot, ArkType, Effect Schema, ...) OR a raw JSON Schema
   * wrapped via `jsonSchema({ ... })`. Used for BOTH:
   *   - Runtime validation of dispatched input (before the handler runs).
   *   - Wire-side JSON Schema sent to the model (derived via
   *     `toJsonSchema()` at projection time).
   *
   * Defaults to `jsonSchema({ type: "object" })` when omitted —
   * accepts any input, no validation.
   */
  readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
  /**
   * Optional output schema. Declares the shape of the handler's
   * `structuredContent` (the typed machine result carried on the ADR 70
   * result envelope). When set, the tool executor validates the handler's
   * `structuredContent` against this schema before the dispatch resolves
   * (a failure is a typed dispatch error, mirroring `inputSchema`), and
   * emits the schema as `outputSchema` on the model's tool definition
   * (provider-dependent; aligned with MCP 2025-11-25 `Tool.outputSchema`).
   *
   * A typed output shape is what unlocks tool COMPOSITION — chaining one
   * tool's typed output into another's typed input, or code that
   * orchestrates several tools — not just validation.
   *
   * Omit for tools returning unstructured content (text/image/etc); the
   * result currency stays `string | ContentBlock[]` and validation is
   * skipped.
   */
  readonly outputSchema?: StandardSchemaV1;
  /**
   * The async function invoked at dispatch time. Receives the
   * validated input + a `ctx` bundle (toolCallId, sessionId,
   * executionId, abort signal, channel emit).
   *
   * Returns the ADR 70 result currency — a `string` (sugar for one
   * text block), a `ContentBlock[]`, or a `{ content, structuredContent?,
   * isError?, metadata? }` envelope (plus the `Promise` / `Effect` /
   * `TaskHandle` wrappers). `structuredContent` is validated against
   * {@link outputSchema} when declared; `isError: true` is a SOFT/domain
   * error (the dispatch resolves) while a throw is a HARD failure (the
   * dispatch rejects). The three shapes stay type-discriminable, so a
   * wrong-shape return is a compile error.
   */
  readonly handler: (input: TInput, args: { readonly ctx: ToolHandlerCtx }) => ToolHandlerResult;
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

/**
 * Structural type guard for {@link CreatedTool}. Discriminates the
 * `createTool` registration bundle from a raw `ToolDeclaration`,
 * other plain objects, or arbitrary runtime values.
 *
 * Used by registries that accept BOTH `CreatedTool[]` shorthand AND
 * raw declarations (e.g., the `mcp-next/server` tools slot). Living
 * in this package keeps the guard next to the type it discriminates
 * — no duplicated structural checks scattered across consumers.
 */
export function isCreatedTool(value: unknown): value is CreatedTool {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.handlerRef === "string" &&
    typeof obj.handler === "function" &&
    typeof obj.declaration === "object" &&
    obj.declaration !== null
  );
}

// ============================================================================
// createTool
// ============================================================================

let autoCounter = 0;

export function createTool<TInput = unknown>(spec: ToolSpec<TInput>): CreatedTool {
  const handlerRef = spec.handlerRef ?? `tool:${spec.name}:${++autoCounter}`;

  const schema: StandardSchemaV1<unknown, TInput> =
    spec.inputSchema ?? (jsonSchema({ type: "object" }) as StandardSchemaV1<unknown, TInput>);

  const declaration: ToolDeclaration = {
    id: spec.name,
    name: spec.name,
    description: spec.description,
    inputSchema: schema,
    ...omitUndefined({ outputSchema: spec.outputSchema }),
    exposure: spec.exposure ?? ["model"],
    handlerRef,
    ...omitUndefined({ annotations: spec.annotations, metadata: spec.metadata }),
  };

  const handler: ToolHandler = (input, { ctx }) => {
    // Return shape forwarded as-is — executor accepts every member of
    // ToolHandlerResult (sync ContentBlock[], Promise, Effect, or
    // TaskHandle / wrapped TaskHandle). Wrapping in `async` here would
    // force-Promise TaskHandle returns into Promise<TaskHandle>, which
    // the executor handles, but stays one indirection cheaper without.
    return spec.handler(input as TInput, { ctx });
  };

  const validator: Validator = spec.inputSchema ? fromStandardSchema(schema) : permissiveValidator;

  return { declaration, handlerRef, handler, validator };
}
