/**
 * Runtime declarations — non-context registrations attached to a
 * {@link RenderedTree}. The runtime can materialize, route, or invoke
 * these; they are NOT model-input content.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §RuntimeDeclarations
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { ContentBlock } from "./content-blocks.js";
import type { CacheHint } from "./entries.js";
import type { ProviderToolOptions } from "./rendered-tree.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import type { ToolHandlerCtx } from "./tool-handler.js";

/**
 * Raw JSON Schema object — retained for WIRE-facing slots only
 * (`LanguageModelTool.inputSchema` in `protocol/executor.ts`,
 * `responseFormat.schema` in rendered-tree). Adopter-facing slots
 * (`ToolDeclaration.inputSchema`, `OutputDeclaration.schema`,
 * `KnobRegistration.schema`) use `StandardSchemaV1` so adopters can
 * bring any validator library; the framework projects to JSON Schema
 * at wire-emission time via `toJsonSchema()`.
 */
export type JsonSchema = Record<string, unknown>;

// ============================================================================
// Tool declaration
// ============================================================================

/**
 * Where a tool is reachable from.
 *
 * `[V1-REPLACED]` of v1's `audience: "model" | "user" | "all"`. The
 * `["model", "dispatch"]` combination is the new "all"; `"user"` becomes
 * `"dispatch"` (clearer about who invokes).
 */
export type ToolExposure = "model" | "dispatch" | "runtime";

/**
 * Provenance tag attached to every {@link ToolRegistration} in the tool
 * executor's registry. Records **which layer of the declaration
 * hierarchy** contributed the registration so the per-tick compile can
 * resolve name collisions deterministically.
 *
 * Internal accounting only — never exposed on the wire, never visible
 * to model providers, never surfaced through `session.dispatch()`.
 *
 * The layered config seams (in increasing specificity) are:
 *
 *   1. `runtime`    — direct programmatic register() with no scope context;
 *                     tests and ad-hoc registrations
 *   2. `gateway`    — `createGateway({ tools })`, process-wide floor
 *   3. `app`        — `createApp(component, { tools })`, app-wide default
 *   4. `session`    — `app.createSession({ tools })`, per-session
 *   5. `execution`  — `session.send({ tools })`, per-call
 *   6. `extension`  — installed via the extension protocol; precedence
 *                     follows the `level` at which it was installed
 *   7. `reconciler` — contributed by the reconciler from the rendered
 *                     tree (any reconciler — React/JSX, programmatic,
 *                     template-based — producing a valid RenderedTree
 *                     uses this slot); replaced fresh per render, most
 *                     specific
 *
 * Precedence on name collision (low → high): runtime < gateway <
 * \{app, extension\@app\} < \{session, extension\@session\} < execution <
 * reconciler.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md §Layered config
 */
export type ToolBinding =
  | { readonly scope: "runtime" }
  | { readonly scope: "gateway" }
  | { readonly scope: "app"; readonly appId: string }
  | { readonly scope: "session"; readonly sessionId: string }
  | { readonly scope: "execution"; readonly executionId: string }
  | {
      readonly scope: "extension";
      readonly extensionName: string;
      readonly level: "gateway" | "app" | "session";
    }
  | { readonly scope: "reconciler"; readonly mountId: string };

/**
 * Predicate form of {@link ToolAnnotations.requiresConfirmation}. Runs
 * at the confirmation gate against the VALIDATED input and the live
 * dispatch {@link ToolHandlerCtx}, returning (sync or async) whether
 * this specific call needs host confirmation. Lets a tool gate on the
 * arguments — e.g. confirm `rm` only outside a scratch dir — rather
 * than a static per-tool boolean.
 *
 * The function is a RUNTIME value, so it never crosses the spec
 * firewall on the wire: like {@link ToolDeclaration.handlerRef}, it is
 * erased from the serialized declaration and evaluated only in-process
 * by the tool executor.
 */
export type ToolConfirmationPredicate = (
  input: unknown,
  ctx: ToolHandlerCtx,
) => boolean | Promise<boolean>;

export interface ToolAnnotations {
  /** `[V1-INHERITED]` Tool intent hint. */
  readonly intent?: "render" | "action" | "compute";
  /**
   * Humanized display name for a tool call ("Write file" vs
   * `write_file`). Presentation ONLY — surfaced on the tool-start
   * lifecycle event and in the resolved {@link ToolPresentation}; never
   * sent to the model as the tool's identifier. Sits at the BOTTOM of the
   * display precedence chain (above the bare `name`):
   * `modelNarration ?? displaySummary ?? title ?? name`. `[V1-RESTORED]`.
   */
  readonly title?: string;
  /**
   * Author's summary of what a SPECIFIC call is doing, for host/UI
   * display. A seam: a static `string` OR a per-call function evaluated
   * at dispatch against the VALIDATED input + live {@link ToolHandlerCtx}
   * (sync or async). Sits in the display precedence chain BELOW the
   * model's own `_summary` narration and ABOVE {@link title}/name:
   * `modelNarration ?? displaySummary ?? title ?? name`.
   *
   * The function form is a RUNTIME value — erased from the serialized
   * declaration (like {@link ToolConfirmationPredicate}); over-the-wire
   * tools use the `string` form. `[V1-RESTORED]`.
   */
  readonly displaySummary?:
    | string
    | ((input: unknown, ctx: ToolHandlerCtx) => string | Promise<string>);
  /**
   * Opt this tool OUT of the injected model-narration `_summary` field.
   * When `false`, the projector skips injecting {@link TOOL_NARRATION_FIELD}
   * into this tool's model-facing schema. Default (unset / `true`):
   * narration is injected whenever the app-level narrate switch is ON.
   * See {@link TOOL_NARRATION_FIELD} for the token-cost tradeoff.
   */
  readonly narrate?: boolean;
  /**
   * CLIENT-HANDLED tools only (declaration carries no `handlerRef`).
   * When `true`, dispatch SUSPENDS and relays the call to the client
   * over the tool-call channel, resolving with the client's returned
   * result. When falsy, dispatch fire-and-forget notifies the client
   * and resolves immediately with {@link defaultResult} (or a canned
   * success). Ignored for server-handled tools.
   */
  readonly requiresResponse?: boolean;
  /**
   * Per-tool wait bound (ms) for a CLIENT-HANDLED tool's relayed
   * result (`requiresResponse === true`). Falls back to the caller's
   * `DispatchInput.responseTimeoutMs`. On timeout the executor uses
   * {@link defaultResult} when set, else fails `ToolCallTimeoutError`.
   */
  readonly responseTimeoutMs?: number;
  /** Milliseconds. */
  readonly timeout?: number;
  /**
   * Gate dispatch on host confirmation. `true` always confirms; a
   * {@link ToolConfirmationPredicate} confirms per-call based on the
   * validated input + ctx (evaluated at the gate, sync or async).
   * When it resolves truthy the tool executor pauses dispatch after
   * validation and elicits approval via the `ElicitationHarness` before
   * invoking the handler. Used for risky / side-effecting tools (file
   * delete, payment, send, etc.).
   *
   * The predicate form is a runtime value and is erased from the
   * serialized declaration (see {@link ToolConfirmationPredicate}).
   *
   * `[V1-INHERITED]` from `ToolDefinition.requiresConfirmation`.
   */
  readonly requiresConfirmation?: boolean | ToolConfirmationPredicate;
  /**
   * Per-tool override of the harness's `defaultConfirmationTimeoutMs`.
   * Milliseconds. When unset, the harness default applies (which
   * defaults to no timeout — wait forever).
   */
  readonly confirmationTimeoutMs?: number;
  /**
   * Human-legible confirmation prompt. Restores v1's `confirmationMessage`.
   * A seam: a static `string` OR a per-call function evaluated at the gate
   * against the VALIDATED input + live dispatch {@link ToolHandlerCtx}
   * (sync or async). When it resolves to a string, that string becomes the
   * elicitation request's `message`; when unset, the executor falls back to
   * its default `Approve tool "<name>"?` prompt.
   *
   * The function form is a RUNTIME value (like {@link ToolConfirmationPredicate}
   * and {@link ToolDeclaration.handlerRef}) — erased from the serialized
   * declaration, evaluated only in-process. Over-the-wire tools use the
   * `string` form (a function can't serialize).
   */
  readonly confirmationMessage?:
    | string
    | ((input: unknown, ctx: ToolHandlerCtx) => string | Promise<string>);
  /**
   * Async preview metadata for the confirm UI (e.g. a rendered diff for a
   * write/edit tool, a cost estimate for a payment). Restores v1's
   * `confirmationPreview`. Awaited at the gate against the VALIDATED input +
   * live {@link ToolHandlerCtx}, then merged into the elicitation request's
   * `metadata` under `metadata.preview` (existing `toolUseId` / `toolName` /
   * `arguments` keys stay intact) so the client dialog can render it.
   *
   * A RUNTIME value — erased from the serialized declaration.
   */
  readonly confirmationPreview?: (
    input: unknown,
    ctx: ToolHandlerCtx,
  ) => Promise<Record<string, unknown>>;
  /**
   * Result the executor resolves with for a CLIENT-HANDLED tool when no
   * live result is produced — fire-and-forget (`requiresResponse` falsy)
   * always uses it; `requiresResponse: true` uses it as the timeout
   * fallback. A seam: static `readonly ContentBlock[]` OR a per-call
   * function on the VALIDATED input + {@link ToolHandlerCtx} (sync or
   * async), evaluated at the resolve site. Absent ⇒ a canned success
   * block. The function form is a runtime value, erased on the wire.
   */
  readonly defaultResult?:
    | readonly ContentBlock[]
    | ((
        input: unknown,
        ctx: ToolHandlerCtx,
      ) => readonly ContentBlock[] | Promise<readonly ContentBlock[]>);
  /** `[V1-INHERITED]` MCP Apps UI hint. */
  readonly ui?: {
    readonly resourceUri?: string;
    readonly visibility?: ReadonlyArray<"model" | "app">;
  };
  readonly cache?: CacheHint;
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
  /**
   * Long-running task semantics — `2025-11-25` core / draft extension
   * (`io.modelcontextprotocol/tasks`).
   *
   *   `"unsupported"` (default) — the tool always runs synchronously;
   *     a `task: {ttl}` opt-in from the caller is rejected.
   *   `"supported"`             — sync OR task-mode at the caller's
   *     choosing. The tool handler should be able to return either a
   *     `ContentBlock[]` (sync) or a `TaskHandle` (task-mode).
   *   `"required"`              — task-mode is the only option; the
   *     handler must return a `TaskHandle`. Sync invocation is
   *     rejected by the executor before the handler runs.
   *
   * Wire mapping is era-aware: `2025-11-25` ships this at the tool-
   * annotation level; draft moves it under the
   * `io.modelcontextprotocol/tasks` extension. The substrate stays
   * vocabulary-stable across both.
   */
  readonly taskSupport?: "unsupported" | "supported" | "required";
  /**
   * Default TTL (ms) for task-mode invocations of this tool. Caller-
   * supplied `task: { ttl }` overrides. Omitted = no expiry (the
   * MCP-aligned "null TTL" semantic).
   */
  readonly taskTtlMs?: number;
}

export interface ToolDeclaration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * Adopter-supplied input schema. Any Standard-Schema-compliant
   * validator (Zod 4, Valibot, ArkType, Effect Schema, ...) OR a raw
   * JSON Schema wrapped via `jsonSchema({ ... })`. Projected to wire
   * JSON Schema for model providers via `toJsonSchema()` at execution
   * time.
   */
  readonly inputSchema: StandardSchemaV1;
  /**
   * Optional output schema. Declares the shape of the tool's
   * `structuredContent` result. Same Standard-Schema acceptance as
   * `inputSchema`. When set:
   *   - Wire emission: included in the model's tool definition under
   *     `outputSchema` (provider-dependent; OpenAI strict-mode,
   *     Anthropic, MCP `Tool.outputSchema`).
   *   - Runtime: the harness MAY validate the handler's
   *     `structuredContent` against this schema and surface
   *     `ToolOutputValidationError` on mismatch.
   * Omit for tools returning unstructured content (text/image/etc).
   */
  readonly outputSchema?: StandardSchemaV1;
  readonly exposure: readonly ToolExposure[];
  /**
   * Alternate dispatch names for this tool. Restores v1's tool `aliases`.
   * The registry resolves a dispatch by exact `name` first, then falls
   * back to scanning aliases (an alias→name index), so
   * `session.dispatch(alias, input)` reaches the same tool. Aliases are
   * DISPATCH names — they live on the declaration, not the annotations —
   * and an alias that collides with a real tool `name` never shadows it
   * (exact-name lookup wins).
   */
  readonly aliases?: readonly string[];
  /**
   * Identifier resolved by the runtime / tool executor to a concrete
   * handler. Never executable code — the spec firewall forbids it.
   */
  readonly handlerRef?: string;
  readonly annotations?: ToolAnnotations;
  readonly metadata?: Record<string, unknown>;
  /**
   * Per-tool provider-specific options. Adapters merge into the
   * provider's tool shape (e.g. OpenAI `strict: true` for JSON-schema
   * mode, Anthropic per-tool `cache_control`). Typed via the
   * augmentable {@link ProviderToolOptions} interface — each adapter
   * package contributes its slot.
   */
  readonly providerOptions?: ProviderToolOptions;
}

/**
 * RESERVED model-input field name for tool-call self-narration.
 *
 * The framework injects an optional `_summary` string property into every
 * model-facing tool schema (gated on the app-level narrate switch + a
 * per-tool {@link ToolAnnotations.narrate} opt-out) so the model can say,
 * in one short first-person sentence, what a call is doing. That sentence
 * lights up the tool-start spinner ("Searching the docs for retry config").
 *
 * The tool executor STRIPS this field from the raw input BEFORE schema
 * validation (a shallow copy — the caller's object is never mutated), so
 * it NEVER reaches the handler or the persisted `tool_result`. A tool
 * whose own schema already declares `_summary` opts out implicitly (the
 * injector skips it to avoid clobbering the author's field).
 *
 * ## Token cost
 *
 * Injecting `_summary` adds one property to EVERY model-facing tool
 * schema AND the model emits an extra sentence per call — real input and
 * output tokens on every tool-using tick. The app-level narrate switch
 * (default ON) is the off-switch; disable it app-wide when the cost isn't
 * worth the live narration.
 *
 * Imported by BOTH the injector (`buildTools`, `@agentick/model-next`) and
 * the stripper (`dispatchBody`, `@agentick/tool-executor-next`).
 */
export const TOOL_NARRATION_FIELD = "_summary" as const;

/**
 * Resolved presentation for a tool call — the "what is this call doing?"
 * answer, drawn from three sources with one precedence chain
 * (`modelNarration ?? displaySummary ?? title ?? name`). Produced by the
 * tool executor at dispatch and surfaced for host/UI display; presentation
 * only, never sent to the model.
 */
export interface ToolPresentation {
  /**
   * The raw tool id (`write_file`) — for keys / logic. Always set. The client
   * falls back to this when {@link title} is absent.
   */
  readonly name: string;
  /**
   * {@link ToolAnnotations.title} — the humanized IDENTITY ("Write File"), when
   * set. What the tool IS, distinct from what this call is doing.
   */
  readonly title?: string;
  /**
   * The author's per-call ACTIVITY description ({@link
   * ToolAnnotations.displaySummary} resolved), when set. What this call is doing.
   */
  readonly summary?: string;
  /**
   * The model's self-narration extracted from {@link TOOL_NARRATION_FIELD},
   * when the model filled it in. Undefined when narration is disabled or
   * the model omitted it.
   */
  readonly narration?: string;
}

// The four fields are surfaced DISTINCTLY and never collapsed — the framework
// presumes no precedence. A client composes identity from `title ?? name` and
// activity from `narration ?? summary` (or shows them separately, or badges the
// model's words). That precedence is a CLIENT concern, not the framework's.

// ============================================================================
// Resource declaration
// ============================================================================

export interface ResourceDeclaration {
  readonly id: string;
  readonly uri?: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  /** Resolved by the runtime to a reader implementation. */
  readonly handlerRef?: string;
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// Output declaration
// ============================================================================

/**
 * Runtime registration for named outputs the application wants to extract
 * from the result. Distinct from {@link SpecConfig.responseFormat} which
 * is a generation-time provider directive.
 */
export interface OutputDeclaration {
  readonly id: string;
  /**
   * Optional output shape validator. Standard-Schema-compliant; same
   * acceptance as `ToolDeclaration.inputSchema`. Projected to JSON
   * Schema for `responseFormat.schema` at wire-emission time.
   */
  readonly schema?: StandardSchemaV1;
  readonly mode?: "text" | "json" | "json_schema";
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// MCP declaration — `[PLACEHOLDER]`
// ============================================================================

export type MCPTransport = "stdio" | "http" | "sse" | "streamable-http";

export interface MCPDeclaration {
  readonly id: string;
  readonly serverName: string;
  readonly transport: MCPTransport;
  /** Transport-specific configuration (URL, command, headers, ...). */
  readonly config: Record<string, unknown>;
  readonly exposes?: ReadonlyArray<"tools" | "resources" | "prompts">;
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// Model declaration — tree-declared per-tick model (ADR 56)
// ============================================================================

/**
 * The serializable model selection a render contributes to the IR (ADR
 * 56). The `modelRef` names a {@link import("../protocol/hook-bridges.js").RegisteredModel}
 * on the mount's {@link import("../protocol/hook-bridges.js").ModelBridge};
 * the loop resolves it per tick and runs that model, taking precedence
 * over the send override and the session/app default.
 *
 * This is the model analogue of {@link ToolDeclaration.handlerRef} — pure
 * data across the spec firewall, the live executor+target lives on the
 * bridge. Single per tick (one model per model call); nearest-scope /
 * last-wins if a tree nests several declarations.
 *
 * `parameters` overlays the compiled tree's generation config
 * (temperature, maxOutputTokens, …) for this tick — the same knobs
 * `RenderedTree.config` carries.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */
export interface ModelDeclaration {
  readonly modelRef: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Aggregate
// ============================================================================

export interface RuntimeDeclarations {
  readonly tools?: readonly ToolDeclaration[];
  readonly resources?: readonly ResourceDeclaration[];
  readonly outputs?: readonly OutputDeclaration[];
  readonly mcp?: readonly MCPDeclaration[];
  /**
   * Tree-declared model for the tick (ADR 56). Single — one model per
   * model call. When a tree nests several `<Model>` declarations, the
   * collector keeps the nearest-scope / last-wins one. Absent ⇒ the loop
   * falls back to the send/session executor+target.
   */
  readonly model?: ModelDeclaration;
}
