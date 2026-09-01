/**
 * Runtime declarations — non-context registrations attached to a
 * {@link RenderedTree}. The runtime can materialize, route, or invoke
 * these; they are NOT model-input content.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §RuntimeDeclarations
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { CacheHint, ContentBlock, ToolExecutor } from "./content-blocks.js";
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
 * to model providers, never surfaced through `session.tools.dispatch()`.
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
 *   7. `client`     — a remote declarative slice a CLIENT owns and
 *                     REPLACES wholesale via `session/set_client_tools`
 *                     (the wire twin of the compiler's
 *                     `replaceCompilerTools`). Session-lifetime; the
 *                     framework clears the client slice and reinstalls
 *                     the declared set on every `set_client_tools`. Held
 *                     DISTINCT from `session` so a client's declarative
 *                     replace never clobbers the app's static
 *                     `createSession({ tools })` slice.
 *   8. `compiler` — contributed by the compiler from the rendered
 *                     tree (any compiler — React/JSX, programmatic,
 *                     template-based — producing a valid RenderedTree
 *                     uses this slot); replaced fresh per render, most
 *                     specific
 *
 * Precedence on name collision (low → high): runtime < gateway <
 * \{app, extension\@app\} < \{session, extension\@session\} < execution <
 * client < compiler.
 *
 * **Where `client` sits — and why.** `client` and `compiler` are the
 * two DECLARATIVE-SLICE-SOURCE scopes: each owns a whole slice its
 * source replaces atomically (`set_client_tools` / `replaceCompilerTools`),
 * unlike the static per-layer config seams (gateway/app/session/execution).
 * `client` is placed just BELOW `compiler`: a live client's current
 * declaration outranks the static session/execution config seams (it is the
 * more specific, up-to-date remote source), but the in-process rendered tree
 * stays authoritative — a tool the running tree declares wins over a
 * same-named client tool. This placement is a deliberate default, not a law:
 * it is tunable in `PRECEDENCE_RANK` (`@agentick/tool-executor`) should a
 * deployment want client tools to outrank the tree.
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
  /**
   * A CLIENT-owned declarative tool slice, keyed by `sessionId`. A client
   * declares its FULL set over `session/set_client_tools`; the framework
   * clears this slice (`removeBoundTools({ binding: { scope: "client",
   * sessionId } })`) and reinstalls the declared tools — the wire twin of
   * `replaceCompilerTools`. Session-lifetime: reaped on session close.
   * DISTINCT from `session` (which holds `createSession({ tools })`) so the
   * slice-replace never clobbers app tools.
   */
  | { readonly scope: "client"; readonly sessionId: string }
  | { readonly scope: "compiler"; readonly mountId: string };

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

/**
 * What the executor-level confirmation policy is handed for one dispatch —
 * everything the gate knows at the moment it must decide whether to ask.
 *
 * `toolVerdict` is the tool's OWN answer ({@link
 * ToolAnnotations.requiresConfirmation}, resolved), so a policy composes with
 * per-tool judgment rather than replacing it: return it to defer, `true` to
 * force an ask the tool did not request (e.g. every MCP tool not marked
 * `readOnlyHint: true`), `false` to suppress one a standing grant already
 * covers (e.g. a per-user "always allow" record).
 */
export interface ToolConfirmationDecision {
  /** The dispatched tool's declaration — annotations included, so MCP advisory hints are readable here. */
  readonly declaration: ToolDeclaration;
  /** The validated input, exactly what the handler would receive. */
  readonly input: unknown;
  /** The live dispatch ctx — session identity, principal, surfaces. */
  readonly ctx: ToolHandlerCtx;
  /** The tool's own `requiresConfirmation`, resolved for this call. */
  readonly toolVerdict: boolean;
}

/**
 * Executor-level confirmation policy — ONE function, configured on the tool
 * executor, consulted for EVERY dispatch. The final say on whether the
 * confirmation gate asks: the framework provides this seam and nothing else,
 * so what a deployment confirms (annotation defaults, privileged servers,
 * durable per-user grants) is app code, not framework policy.
 *
 * A runtime value like {@link ToolConfirmationPredicate}: never serialized,
 * evaluated in-process only. Async so a grant lookup can hit a store. The
 * session-scoped "always allow" a user grants THROUGH a confirmation reply
 * still applies after this returns `true`.
 */
export type ToolConfirmationPolicy = (
  decision: ToolConfirmationDecision,
) => boolean | Promise<boolean>;

export interface ToolAnnotations {
  /** `[V1-INHERITED]` Tool intent hint. */
  readonly intent?: "render" | "action" | "compute";
  /**
   * Backlog F (internal-visibility.md) — this tool is INTERNAL: its `tool_use`
   * calls and `tool_result`s are stamped `internal` (client-hidden; the model
   * still reads them). Resolved via the session registry when a call is seen,
   * and inherited by the result. Distinct from `exposure` (reachability): an
   * `internal` tool is still model-callable, its activity just isn't delivered.
   */
  readonly internal?: boolean;
  /**
   * MCP-aligned advisory hint: the tool does not mutate its environment.
   * All four hints are a tool's SELF-DESCRIPTION — advisory, never enforced
   * by the framework, and never trustworthy from an untrusted server.
   */
  readonly readOnlyHint?: boolean;
  /** Advisory: the tool may perform destructive updates (meaningful when not read-only). */
  readonly destructiveHint?: boolean;
  /** Advisory: repeat calls with the same arguments have no additional effect. */
  readonly idempotentHint?: boolean;
  /** Advisory: the tool interacts with external entities rather than a closed domain. */
  readonly openWorldHint?: boolean;
  /**
   * Humanized display name for a tool call ("Write file" vs
   * `write_file`). Presentation ONLY — surfaced on the tool-start
   * lifecycle event and in the resolved {@link ToolPresentation}; never
   * sent to the model as the tool's identifier. The IDENTITY axis (what
   * the tool IS): resolved to {@link ToolPresentation.title} and surfaced
   * DISTINCTLY alongside the author's `displaySummary` and the model's
   * `narration` — the framework collapses none of them. A client composes
   * identity from `title ?? name`; that precedence is the client's call,
   * not the framework's. `[V1-RESTORED]`.
   */
  readonly title?: string;
  /**
   * Author's summary of what a SPECIFIC call is doing, for host/UI
   * display. A seam: a static `string` OR a per-call function evaluated
   * at dispatch against the VALIDATED input + live {@link ToolHandlerCtx}
   * (sync or async). The author's ACTIVITY axis (what this call does):
   * resolved to {@link ToolPresentation.summary} and surfaced DISTINCTLY
   * from the model's own `_summary` narration ({@link ToolPresentation.narration})
   * and from {@link title}/name — the framework collapses none of them. A
   * client composes activity from `narration ?? summary`; that precedence is
   * the client's call, not the framework's.
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
   * Run this in EVERY attached client, not only the one that asked.
   *
   * A call carries the client it is for, and normally that is whoever's request
   * started the turn — right for anything acting on the user's attention, where
   * a second tab acting too is the bug. A few tools are the opposite: a toast,
   * a cache invalidation, a grid refresh. Those want everyone, and the server
   * stamps no target for them.
   *
   * Pairs naturally with `requiresResponse: false` — with several clients
   * answering there is no single authoritative reply, and the first to arrive
   * wins while the rest are dropped.
   */
  readonly broadcast?: boolean;
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
   * DECLARATION-level execution provenance — WHO the tool executor routes this
   * tool to, stamped onto the resulting {@link import("./content-blocks.js").ToolResultBlock.executedBy}.
   * A serializable {@link ToolExecutor} string ("agentick" | "client" |
   * "provider:<key>" | "mcp:<server>"). When a server-handled dispatch
   * resolves, the executor stamps `annotations.executedBy ?? "agentick"` on the
   * result, so a harness that routes elsewhere (e.g. the MCP harness →
   * `"mcp:<serverId>"`) declares it ONCE here rather than at every stamp site.
   *
   * SECURITY — server-authoritative, NEVER wire-settable. This field is
   * deliberately ABSENT from {@link ClientToolAnnotations}: a client declaring
   * its own `executedBy` would SPOOF provenance (claim its tool ran on a
   * provider / MCP server). Two independent guards enforce this: (1) the
   * executor only READS `executedBy` on the SERVER-handled path, which
   * client-declared tools (no `handlerRef`) never reach — they are stamped a
   * hardcoded `"client"`; and (2) {@link import("../protocol/tool-executor.js").toClientToolRegistration}
   * strips it at the wire fold as defense-in-depth. Populated only by
   * in-process harnesses (see `mcpDeclaration`), never from the wire.
   */
  readonly executedBy?: ToolExecutor;
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
   * ONE sentence: what the tool does. The currency of a capabilities
   * section — the always-in-context listing that tells the model the lay of
   * the land without spending a schema on every tool. Static and
   * call-independent, unlike {@link ToolAnnotations.displaySummary} (what a
   * SPECIFIC call is doing) and {@link ToolPresentation.summary} (that one
   * resolved). Crosses the wire on {@link import("../protocol/tool-executor.js").ToolInfo}.
   */
  readonly summary?: string;
  /**
   * Where this tool sits in the capability tree, as a PATH:
   * `["api", "jobs"]`. The tree is the SET of paths — dispatch never consults
   * this. A renderer derives its tree view by grouping the flat tool list on
   * this field; {@link ToolGroupInfo} is where a group's PROSE lives (one
   * declaration per group, never repeated per tool — the cardinality every
   * grouping proposal converges on: MCP SEP-993/-1300, WebMCP collections).
   */
  readonly group?: readonly string[];
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
   * `session.tools.dispatch(alias, input)` reaches the same tool. Aliases are
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

// ============================================================================
// Client tool declaration — the serializable wire slice of ToolDeclaration
// ============================================================================

/**
 * The SERIALIZABLE subset of {@link ToolAnnotations} a client may send when
 * declaring its tool set over the wire (`session/set_client_tools`). Every
 * field here JSON-serializes; the callable seams on {@link ToolAnnotations}
 * (`requiresConfirmation` predicate, `confirmationMessage` / `displaySummary`
 * / `defaultResult` FUNCTION forms, `confirmationPreview`) are runtime values
 * that cannot cross the wire and are simply ABSENT from this projection.
 *
 * Structurally assignable to {@link ToolAnnotations}: each field narrows to
 * the static form of the corresponding annotation, so a
 * {@link ClientToolDeclaration} folds into a {@link ToolDeclaration} without
 * a cast.
 *
 * SECURITY — {@link ToolAnnotations.executedBy} is DELIBERATELY OMITTED here.
 * `executedBy` is server-authoritative execution provenance; letting a client
 * declare it would let a client SPOOF where its tool ran (claim `"mcp:<server>"`
 * or `"provider:<key>"`). Its absence from this wire slice means a
 * well-typed client cannot set it, and {@link import("../protocol/tool-executor.js").toClientToolRegistration}
 * strips it at the wire fold even if a raw payload smuggles it as an excess
 * property. See {@link ToolAnnotations.executedBy}.
 */
export interface ClientToolAnnotations {
  readonly intent?: "render" | "action" | "compute";
  /** Humanized display identity. Presentation only. */
  readonly title?: string;
  /**
   * `true` ⇒ the client-handled dispatch SUSPENDS and relays the call to the
   * client, resolving with the client's returned result. Falsy ⇒
   * fire-and-forget (notify + resolve with {@link defaultResult}).
   */
  readonly requiresResponse?: boolean;
  /**
   * Run this in EVERY attached client, not only the one that asked.
   *
   * A call carries the client it is for, and normally that is whoever's request
   * started the turn — right for anything acting on the user's attention, where
   * a second tab acting too is the bug. A few tools are the opposite: a toast,
   * a cache invalidation, a grid refresh. Those want everyone, and the server
   * stamps no target for them.
   *
   * Pairs naturally with `requiresResponse: false` — with several clients
   * answering there is no single authoritative reply, and the first to arrive
   * wins while the rest are dropped.
   */
  readonly broadcast?: boolean;
  /** Per-tool wait bound (ms) for the relayed result. */
  readonly responseTimeoutMs?: number;
  /** Per-call timeout (ms). */
  readonly timeout?: number;
  /**
   * Static confirmation gate. Over the wire only the boolean form is
   * expressible; the per-call {@link ToolConfirmationPredicate} is server-only.
   */
  readonly requiresConfirmation?: boolean;
  /** Per-tool confirmation-wait timeout (ms). */
  readonly confirmationTimeoutMs?: number;
  /** Static confirmation prompt. The function form is server-only. */
  readonly confirmationMessage?: string;
  /**
   * Static fallback result blocks — used for fire-and-forget and as the
   * relayed-result timeout fallback. The function form is server-only.
   */
  readonly defaultResult?: readonly ContentBlock[];
  /** Long-running task semantics. */
  readonly taskSupport?: "unsupported" | "supported" | "required";
  /** Default TTL (ms) for task-mode invocations. */
  readonly taskTtlMs?: number;
}

/**
 * The serializable slice of a {@link ToolDeclaration} a CLIENT sends — as one
 * element of the full set — when it DECLARES its tools into a session over the
 * wire (`session/set_client_tools`).
 *
 * Two firewall-driven differences from {@link ToolDeclaration}:
 *
 *   1. `inputSchema` is a raw {@link JsonSchema} object, NOT a
 *      `StandardSchemaV1` validator — a validator is a runtime function and
 *      cannot serialize. The server wraps it into a Standard-Schema validator
 *      (`jsonSchema(inputSchema)`) at registration time; see
 *      {@link import("../protocol/tool-executor.js").toClientToolRegistration}.
 *   2. NO `handlerRef` — its absence is the CLIENT-HANDLED discriminator (the
 *      tool executor relays dispatch to the client instead of invoking a local
 *      handler). The registration built from this declaration deliberately
 *      omits `handlerRef`.
 *
 * `annotations` is the serializable {@link ClientToolAnnotations} slice (the
 * callable seams are server-only and absent). `id` is not carried — the
 * server derives it from `name`.
 */
/**
 * One capability-tree group's prose — the paragraph a prompt renders above the
 * tool names filed under {@link ToolDeclaration.group}. Declared ONCE per group:
 * a group is a per-group fact, so carrying its prose on member tools would mean
 * N wire copies and a dedupe with no authority rule.
 *
 * Reaches a render as {@link RenderContext.toolGroups}, registered through the
 * tool executor's `groups` handle — by the app (config), an extension, or the
 * MCP client surfacing a server's manifest (`_meta["agentick/toolGroups"]` on
 * the `tools/list` result).
 */
export interface GroupInfo {
  /** The group's address — the same path its members carry. */
  readonly path: readonly string[];
  readonly title: string;
  /** The paragraph the model reads. Hand-written prompt-craft, not derived. */
  readonly summary: string;
  /** Render order among siblings; unset sorts after every set value. */
  readonly order?: number;
}

/**
 * {@link GroupInfo}, in the tool namespace. The shape is namespace-agnostic on
 * purpose: prompts, resources and skills group the same way (MCP discussion
 * #1772 treats Group as one primitive across all three), and each namespace
 * gets its own registry and wire key (`agentick/toolGroups`, …) when it lands.
 */
export type ToolGroupInfo = GroupInfo;

export interface ClientToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** One sentence: what the tool does. See {@link ToolDeclaration.summary}. */
  readonly summary?: string;
  /** Capability-tree path. See {@link ToolDeclaration.group}. */
  readonly group?: readonly string[];
  /**
   * Raw JSON Schema object for the tool input. Wrapped server-side into a
   * `StandardSchemaV1` via `jsonSchema(...)` — the wire cannot carry a live
   * validator.
   */
  readonly inputSchema: JsonSchema;
  readonly annotations?: ClientToolAnnotations;
  /** Alternate dispatch names. */
  readonly aliases?: readonly string[];
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
 * Imported by BOTH the injector (`buildTools`, `@agentick/model`) and
 * the stripper (`dispatchBody`, `@agentick/tool-executor`).
 */
export const TOOL_NARRATION_FIELD = "_summary" as const;

/**
 * Resolved presentation for a tool call — the "what is this call doing?"
 * answer along TWO axes, identity (what the tool IS) and activity (what
 * this call DOES), drawn from four sources surfaced as FOUR DISTINCT
 * fields — `name`, `title`, `summary`, `narration` — never collapsed into a
 * single precedence chain. Produced by the tool executor at dispatch and
 * surfaced for host/UI display; presentation only, never sent to the model.
 * The framework presumes NO precedence: a client composes identity from
 * `title ?? name` and activity from `narration ?? summary` (or shows them
 * separately, or badges the model's words) — that precedence is a client
 * concern, not the framework's.
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
 * How a structured output is DELIVERED (three-audiences-plan §B2).
 *
 *   - `"tool"` — inject a synthetic TERMINAL TOOL whose `inputSchema` IS the
 *     output schema; the model calls it to deliver the final answer, and the
 *     call is the completion event. Validation is native (providers constrain
 *     tool arguments) and "done" == "shaped".
 *   - `"responseFormat"` — a generation-time `responseFormat` directive on
 *     every tick; the final assistant text is parsed + validated. Strictly
 *     weaker on multi-tick / tool-using turns (see the plan) — its domain is
 *     the bare single-tick send (`generateObject`).
 *   - `"auto"` (default) — the loop resolves it at tick 1: the terminal tool
 *     when the tick exposes model tools (multi-tick agentic), plain
 *     `responseFormat` when the send is bare.
 */
export type OutputStrategy = "auto" | "tool" | "responseFormat";

/**
 * Runtime registration for named outputs the application wants to extract
 * from the result. Distinct from {@link SpecConfig.responseFormat} which
 * is a generation-time provider directive.
 *
 * `<Output>` compiles to this: "every execution of this agent produces this
 * shape" (dedicated extraction agents, skill-runner children, forks). The
 * loop consumes the FIRST entry to derive its {@link OutputSpec}; a
 * send-level `SendInput.output` overrides it (explicit-beats-ambient).
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
  /**
   * Terminal-tool NAME for the `"tool"` strategy (three-audiences-plan §B2).
   * Defaults to `"submit_result"`. A tree tool of the same name SHADOWS the
   * terminal binding, so the loop throws `TerminalToolNameCollision` rather
   * than silently shadowing.
   */
  readonly name?: string;
  /** Terminal-tool DESCRIPTION — the "when done, call this" instruction. */
  readonly description?: string;
  /** Delivery strategy — see {@link OutputStrategy}. Defaults to `"auto"`. */
  readonly strategy?: OutputStrategy;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The resolved structured-output directive threaded from the session to the
 * loop for one execution (three-audiences-plan §B2). Carries the LIVE
 * `StandardSchemaV1` (in-process only — same tolerance as the other
 * non-serializable `RunExecutionInput` refs; `output` never crosses the wire
 * by construction). Sourced from `SendInput.output` (send-level, redefined)
 * OR derived from the tree-level {@link OutputDeclaration} inside the loop;
 * send-level wins.
 */
export interface OutputSpec {
  /** Terminal-tool name for the `"tool"` strategy. Default `"submit_result"`. */
  readonly toolName: string;
  /** Terminal-tool description (the completion instruction). */
  readonly description?: string;
  /** The live output-shape validator. */
  readonly schema: StandardSchemaV1;
  /** Delivery strategy — see {@link OutputStrategy}. */
  readonly strategy: OutputStrategy;
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
// Provider tool declaration — provider-EXECUTED tools (bypass the executor)
// ============================================================================

/**
 * A PROVIDER-EXECUTED tool request. Where a {@link ToolDeclaration} names a
 * function the framework's tool executor dispatches, a provider tool runs
 * entirely INSIDE the provider — OpenAI `web_search` / `code_interpreter`,
 * Anthropic `server_tool_use`, Google grounding — and its result rides back
 * on the model response (a `tool_result` block stamped `executedBy:
 * "provider:<key>"`; see {@link ToolExecutor}), never entering the executor.
 *
 * **Why a distinct slot, not a `type: "provider"` discriminator on
 * {@link ToolDeclaration}.** A provider tool has NONE of the executor's
 * concerns: no `inputSchema` to validate (the provider owns the arguments),
 * no `handlerRef` to resolve, no confirmation gate, no client-relay, no
 * `_summary` narration. Folding it into `ToolDeclaration` would force every
 * executor seam to special-case a "tool" that never dispatches, and would
 * violate the executor's `handlerRef present ⇒ server / absent ⇒ client`
 * binary — a provider tool carries no handler yet is NOT client-handled.
 * So it is a SIBLING declaration at the IR: the loop threads it straight
 * from `RuntimeDeclarations.providerTools` to the executor's `project`
 * phase, never through `ToolExecutorProtocol.compileForTick`. It is never
 * registered in the tool executor and emits no `tool:dispatch` lifecycle.
 *
 * The declaration is pure, serializable data — it crosses the spec firewall
 * unchanged and projects verbatim to {@link import("../protocol/executor.js").ProviderToolWire}.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 * @see import("../protocol/executor.js").ProviderToolWire — the wire twin
 */
export interface ProviderToolDeclaration {
  /**
   * Routing key — which adapter OWNS this tool
   * (`"openai"` | `"anthropic"` | `"google"` | …). An adapter enables
   * ONLY the provider tools whose `provider` matches its own key and maps
   * them into the provider's native tools array; every other adapter
   * passes them through untouched. No dispatch, no fan-out — the routing
   * key is the sole selector.
   */
  readonly provider: string;
  /**
   * The provider-NATIVE tool type, written verbatim
   * (`"web_search_preview"`, `"code_interpreter"`, `"web_search_20250305"`).
   * The framework performs NO cross-provider normalization: the adopter
   * writes the provider's own type string and the adapter forwards it as
   * given. A portable, provider-agnostic vocabulary is a later layer built
   * ON TOP of this raw pass-through, not baked into the substrate.
   */
  readonly type: string;
  /**
   * Stable framework id for provenance / dedup AND the `name` the model
   * sees for this tool. Defaults to {@link type} when unset — the resolved
   * `name ?? type` is what the projection dedupes on (with {@link provider})
   * and emits on the wire.
   */
  readonly name?: string;
  /**
   * Provider-native configuration, passed through VERBATIM into the
   * provider's tool shape (allowed domains, max results, container config,
   * …). Adapter-specific and un-inspected by the substrate — the adapter
   * that owns {@link provider} interprets it.
   */
  readonly config?: Record<string, unknown>;
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
  /**
   * Provider-EXECUTED tools for the tick (OpenAI `web_search`, Anthropic
   * `server_tool_use`, Google grounding). These BYPASS the tool executor
   * entirely — they are never registered, never dispatched, never folded
   * by `compileForTick`; the loop threads them straight from here to the
   * executor's `project` phase (→
   * {@link import("../protocol/executor.js").ProjectInput.providerTools}).
   *
   * Merge is a simple concatenation with NO precedence ladder: the
   * projection dedupes by `provider` + resolved `name` (`name ?? type`),
   * last-wins. Unlike `tools` — which resolves collisions across the
   * layered gateway/app/session/execution/extension/compiler seams — a
   * provider tool has no layered identity, so the flat merge is honest.
   * TODO(pass-d): introduce a precedence ladder here if provider-tool
   * collisions across declaration layers ever become meaningful.
   */
  readonly providerTools?: readonly ProviderToolDeclaration[];
}
