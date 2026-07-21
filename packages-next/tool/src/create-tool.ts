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
  ContentBlock,
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
   * OPTIONAL. Omit it to declare a CLIENT-HANDLED tool: `createTool`
   * synthesizes no `handlerRef` (the declaration's `handlerRef` stays
   * `undefined`) and registers no handler, so the tool executor relays
   * dispatch to the client rather than invoking a server handler. This
   * is the server-side way to declare a client tool.
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
  readonly handler?: (input: TInput, args: { readonly ctx: ToolHandlerCtx }) => ToolHandlerResult;
  /**
   * Where the tool is reachable from. Defaults to `["model"]`.
   *   - `"model"` — model-callable via function-calling
   *   - `"dispatch"` — host-callable via `session.dispatch(name, input)`
   *   - `"runtime"` — internal-only
   */
  readonly exposure?: readonly ToolExposure[];
  /** Annotations: requiresConfirmation, timeout, intent, etc. */
  readonly annotations?: ToolAnnotations;
  /**
   * Humanized display name for this tool's calls ("Write file" vs
   * `write_file`). Presentation only — surfaced on the tool-start
   * lifecycle event / resolved `ToolPresentation`, never the model-facing
   * identifier. Threaded onto {@link ToolAnnotations.title} (top-level
   * wins over any set inside `annotations`). `[V1-RESTORED]`.
   */
  readonly title?: string;
  /**
   * Author's summary of what a SPECIFIC call is doing, for host/UI
   * display. A seam: a static `string` OR a per-call function on the
   * tool's VALIDATED input + dispatch ctx (sync or async). The author's
   * ACTIVITY axis — resolved to `ToolPresentation.summary` and surfaced
   * DISTINCTLY from the model's own `_summary` narration and from
   * `title`/name; the framework collapses none of them (the client
   * composes precedence). Typed to `TInput`; erased to `unknown` on
   * {@link ToolAnnotations.displaySummary} (same typed-on-createTool /
   * erased-on-declaration pattern as `handler`). `[V1-RESTORED]`.
   */
  readonly displaySummary?:
    | string
    | ((input: TInput, ctx: ToolHandlerCtx) => string | Promise<string>);
  /**
   * Opt this tool OUT of the injected model-narration `_summary` field.
   * `false` skips injecting `_summary` into this tool's model-facing
   * schema even when the app-level narrate switch is ON. Default
   * (unset / `true`): narration is injected. Threaded onto
   * {@link ToolAnnotations.narrate}.
   */
  readonly narrate?: boolean;
  /**
   * Human-legible confirmation prompt for the confirmation gate. A seam:
   * a static `string` OR a per-call function on the tool's VALIDATED input
   * + dispatch ctx (sync or async), evaluated at the gate into the
   * elicitation request's `message` (falling back to a default prompt).
   * Typed here to `TInput`; erased to `unknown` on the declaration's
   * {@link ToolAnnotations.confirmationMessage} (the same typed-on-createTool
   * / erased-on-declaration pattern as `handler`). Threaded into
   * `annotations.confirmationMessage` (top-level wins over any set inside
   * `annotations`).
   */
  readonly confirmationMessage?:
    | string
    | ((input: TInput, ctx: ToolHandlerCtx) => string | Promise<string>);
  /**
   * Async preview metadata for the confirm UI (e.g. a diff for a
   * write/edit tool). Awaited at the gate against the VALIDATED input + ctx
   * and merged under the elicitation request's `metadata.preview`. Typed to
   * `TInput`; threaded into `annotations.confirmationPreview`.
   */
  readonly confirmationPreview?: (
    input: TInput,
    ctx: ToolHandlerCtx,
  ) => Promise<Record<string, unknown>>;
  /**
   * Result the executor resolves with for a CLIENT-HANDLED tool (handler
   * omitted) when no live result is produced — fire-and-forget always uses
   * it; `requiresResponse: true` uses it as the timeout fallback. A seam:
   * static `readonly ContentBlock[]` OR a per-call function on the VALIDATED
   * input + ctx (sync or async). Typed to `TInput`; threaded into
   * `annotations.defaultResult`.
   */
  readonly defaultResult?:
    | readonly ContentBlock[]
    | ((
        input: TInput,
        ctx: ToolHandlerCtx,
      ) => readonly ContentBlock[] | Promise<readonly ContentBlock[]>);
  /**
   * Alternate dispatch names. `session.dispatch(alias, input)` resolves to
   * this tool (registry resolves by exact `name` first, then alias).
   * Threaded onto {@link ToolDeclaration.aliases}.
   */
  readonly aliases?: readonly string[];
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
  /**
   * All three are ABSENT for a CLIENT-HANDLED tool (created with no
   * `handler`): there is no server handler to resolve, so
   * `declaration.handlerRef` is `undefined` and the executor relays
   * dispatch to the client. Present for the common server-handled tool.
   */
  readonly handlerRef?: string;
  readonly handler?: ToolHandler;
  readonly validator?: Validator;
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
 *
 * The discriminator is the NESTED `declaration` object: a raw
 * `ToolDeclaration` carries `name`/`inputSchema` at the top level and
 * has no `declaration` field. This admits CLIENT-HANDLED bundles
 * (handler-less `createTool`, where `handler`/`handlerRef` are absent);
 * when present, `handler` must be a function.
 */
export function isCreatedTool(value: unknown): value is CreatedTool {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.declaration !== "object" || obj.declaration === null) return false;
  // A server-handled bundle carries a function handler + string ref;
  // a client-handled bundle omits both. Reject partial/garbage shapes.
  if (obj.handler !== undefined && typeof obj.handler !== "function") return false;
  if (obj.handlerRef !== undefined && typeof obj.handlerRef !== "string") return false;
  return true;
}

// ============================================================================
// createTool
// ============================================================================

let autoCounter = 0;

/**
 * Merge the typed-on-`createTool` confirmation seams (`confirmationMessage`
 * / `confirmationPreview` / `defaultResult`) into the erased
 * {@link ToolAnnotations} carried by the declaration. Top-level spec fields
 * win over any equivalents set inside `spec.annotations`. The `TInput`
 * typing erases to `unknown` here — mirroring how the typed `handler`
 * lands on the erased declaration. Returns `undefined` when nothing
 * contributes an annotation (so `omitUndefined` drops the slot).
 */
function buildAnnotations<TInput>(spec: ToolSpec<TInput>): ToolAnnotations | undefined {
  const seams = omitUndefined({
    confirmationMessage: spec.confirmationMessage as ToolAnnotations["confirmationMessage"],
    confirmationPreview: spec.confirmationPreview as ToolAnnotations["confirmationPreview"],
    defaultResult: spec.defaultResult as ToolAnnotations["defaultResult"],
    // Pass B — tool-call presentation seams. `title`/`narrate` are plain
    // values; `displaySummary` erases its `TInput` typing to `unknown`
    // here, mirroring `confirmationMessage`.
    title: spec.title,
    displaySummary: spec.displaySummary as ToolAnnotations["displaySummary"],
    narrate: spec.narrate,
  });
  if (spec.annotations === undefined && Object.keys(seams).length === 0) return undefined;
  return { ...spec.annotations, ...seams };
}

export function createTool<TInput = unknown>(spec: ToolSpec<TInput>): CreatedTool {
  const schema: StandardSchemaV1<unknown, TInput> =
    spec.inputSchema ?? (jsonSchema({ type: "object" }) as StandardSchemaV1<unknown, TInput>);

  const annotations = buildAnnotations(spec);

  // No handler → CLIENT-HANDLED tool: synthesize no handlerRef (the
  // declaration stays `handlerRef`-less so the executor relays dispatch
  // to the client) and register no handler / validator.
  if (spec.handler === undefined) {
    const declaration: ToolDeclaration = {
      id: spec.name,
      name: spec.name,
      description: spec.description,
      inputSchema: schema,
      ...omitUndefined({ outputSchema: spec.outputSchema }),
      exposure: spec.exposure ?? ["model"],
      ...omitUndefined({
        handlerRef: spec.handlerRef,
        aliases: spec.aliases,
        annotations,
        metadata: spec.metadata,
      }),
    };
    return { declaration };
  }

  const specHandler = spec.handler;
  const handlerRef = spec.handlerRef ?? `tool:${spec.name}:${++autoCounter}`;

  const declaration: ToolDeclaration = {
    id: spec.name,
    name: spec.name,
    description: spec.description,
    inputSchema: schema,
    ...omitUndefined({ outputSchema: spec.outputSchema }),
    exposure: spec.exposure ?? ["model"],
    handlerRef,
    ...omitUndefined({ aliases: spec.aliases, annotations, metadata: spec.metadata }),
  };

  const handler: ToolHandler = (input, { ctx }) => {
    // Return shape forwarded as-is — executor accepts every member of
    // ToolHandlerResult (sync ContentBlock[], Promise, Effect, or
    // TaskHandle / wrapped TaskHandle). Wrapping in `async` here would
    // force-Promise TaskHandle returns into Promise<TaskHandle>, which
    // the executor handles, but stays one indirection cheaper without.
    return specHandler(input as TInput, { ctx });
  };

  const validator: Validator = spec.inputSchema ? fromStandardSchema(schema) : permissiveValidator;

  return { declaration, handlerRef, handler, validator };
}
