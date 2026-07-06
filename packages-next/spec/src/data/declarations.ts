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

export interface ToolAnnotations {
  /** `[V1-INHERITED]` Tool intent hint. */
  readonly intent?: "render" | "action" | "compute";
  readonly requiresResponse?: boolean;
  /** Milliseconds. */
  readonly timeout?: number;
  /**
   * When true, the tool executor pauses dispatch after validation and
   * waits for an external `confirmation-response` inbox message before
   * invoking the handler. Used for risky / side-effecting tools (file
   * delete, payment, send, etc.).
   *
   * `[V1-INHERITED]` from `ToolDefinition.requiresConfirmation`.
   */
  readonly requiresConfirmation?: boolean;
  /**
   * Per-tool override of the harness's `defaultConfirmationTimeoutMs`.
   * Milliseconds. When unset, the harness default applies (which
   * defaults to no timeout — wait forever).
   */
  readonly confirmationTimeoutMs?: number;
  readonly defaultResult?: readonly ContentBlock[];
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
