/**
 * `McpServerOptions` — flat adopter API for the MCP server harness.
 *
 * This is the type adopters write when configuring a server. The
 * harness consumes it directly. Aligns with v2's flat-options
 * convention (cf. `withSkills`, `withPrompts`, `withTasks`).
 *
 * Architectural choice: NO separate `config` nesting, NO duplicate
 * transports list. Transports are runtime-only — `ServerTransport`
 * carries its own `kind` discriminator, which the harness extracts
 * for transport-aware security defaults. Adopters write transport
 * names once.
 *
 * Tools projection lives ALONGSIDE the canonical registry under a
 * single `tools` field. Same for `prompts` when #171d lands. This
 * keeps related concerns together and removes the v1-style shadowing
 * where `tools` could mean "registry" or "projection" depending on
 * scope.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §1, §2
 */

import {
  isPromptsInstance,
  isTaskHandle,
  McpServerConfigInvalid,
  type McpRequestContext,
  type PromptDeclaration,
  type Prompts,
  type ToolDeclaration,
} from "@agentick/spec-next";
import {
  isCreatedTool,
  isToolCatalog,
  staticToolCatalog,
  type CreatedTool,
  type ToolCatalog,
} from "@agentick/tool-next";
import type { ToolTransform } from "@agentick/tool-next/transforms";

import type {
  Authenticator,
  Authorizer,
  ConnectionGuard,
  InputSanitizer,
  RateLimiter,
} from "./security/stages.js";
import type { ServerTransport } from "./transports/types.js";
import type { ToolHandlerResolver } from "./projection/tools.js";
import type { CompletionHandler } from "../protocol/completions.js";

/**
 * Per-connection visibility predicate for tools. Hidden tools are
 * invisible to BOTH `tools/list` AND `tools/call` — symmetric with
 * the prompts-projection filter.
 */
export type ToolsFilter = (tool: ToolDeclaration, ctx: McpRequestContext) => boolean;

/**
 * Config-object form of the tools slot. Authoring patterns (mutually
 * exclusive — exactly ONE must be present):
 *
 *   - `tools: CreatedTool[]` — the standard ergonomic shape. Server
 *     builds an internal registry + handler resolver from each
 *     `CreatedTool` bundle. Matches the top-level array shorthand
 *     with added projection rules.
 *
 *   - `registry: ToolDeclaration[]` + `resolveHandler:
 *     ToolHandlerResolver` — the low-level escape hatch for advanced
 *     adopters: custom handler resolution (lookup tables, late-bound
 *     dispatch), dynamic registries, projection-layer tests, etc.
 *     Both fields must appear together.
 *
 * Form B (an existing `Tools` instance via `use:`) is architecturally
 * blocked on `DispatchInput.ctxOverride` (spec evolution): the
 * `ToolExecutorProtocol` builds its OWN `ToolHandlerCtx` per dispatch
 * and would clobber the MCP-server `transport` / `mcp.*` fields.
 * Filed as a follow-up; see ADR 42 audit row.
 */
export interface McpServerToolsConfig {
  /** Inline tools — server builds an internal handler registry from each. */
  readonly tools?: readonly CreatedTool[];
  /**
   * Low-level: explicit canonical registry (paired with `resolveHandler`).
   *
   * Accepts either a static `readonly ToolDeclaration[]` OR a
   * {@link ToolCatalog} for reactive tool-set changes. Adopters who
   * want MCP clients to receive `notifications/tools/list_changed`
   * when the tool set mutates should pass a catalog (see
   * `createToolCatalog` from `@agentick/tool-next`). Arrays wrap
   * internally as static catalogs — no change in behavior.
   */
  readonly registry?: readonly ToolDeclaration[] | ToolCatalog;
  /** Low-level: explicit handler resolver (paired with `registry`). */
  readonly resolveHandler?: ToolHandlerResolver;
  /** Per-connection visibility predicate. */
  readonly filter?: ToolsFilter;
  /** Per-connection name / metadata / schema transforms. Applied left-to-right. */
  readonly transforms?: readonly ToolTransform<McpRequestContext>[];
}

/**
 * The tools slot accepts two shapes (per ADR 42 §"slot trichotomy" —
 * Form B / instance shorthand is deferred; see {@link McpServerToolsConfig}
 * for the rationale):
 *
 *   1. `readonly CreatedTool[]` — array shorthand. Server builds the
 *      underlying registry + handler resolver internally and owns its
 *      lifecycle.
 *   2. {@link McpServerToolsConfig} — config object: either inline
 *      `tools: CreatedTool[]` OR the low-level
 *      `registry + resolveHandler` pair, plus optional `filter` +
 *      `transforms`.
 *
 * Discrimination is structural — arrays go to form 1, plain objects go
 * to form 2.
 */
export type McpServerToolsOptions = readonly CreatedTool[] | McpServerToolsConfig;

/**
 * Per-connection visibility predicate for prompts. Hidden prompts are
 * invisible to BOTH `prompts/list` AND `prompts/get` — symmetric with
 * the tools-projection filter.
 */
export type PromptsFilter = (decl: PromptDeclaration, ctx: McpRequestContext) => boolean;

/**
 * Config-object form of the prompts slot. Either supply
 * `declarations` (the server constructs an internal `Prompts` source
 * and owns its lifecycle), OR supply `use` (an adopter-owned `Prompts`
 * source — adopter retains lifecycle ownership). At most one.
 */
export interface McpServerPromptsConfig {
  /** Declarations the server should register into a freshly-constructed Prompts source. */
  readonly declarations?: readonly PromptDeclaration[];
  /** Adopter-supplied Prompts source. Server does NOT close this on its own close. */
  readonly use?: Prompts;
  /** Per-connection visibility predicate. */
  readonly filter?: PromptsFilter;
}

/**
 * The prompts slot accepts three shapes:
 *
 *   1. `readonly PromptDeclaration[]` — declarations shorthand. Server
 *      constructs the underlying Prompts source internally and owns
 *      its lifecycle.
 *   2. `Prompts` — instance shorthand. Adopter-supplied; server uses
 *      as-is and never closes it.
 *   3. {@link McpServerPromptsConfig} — config object for declarations
 *      OR an existing instance, plus optional per-connection `filter`.
 *
 * Discrimination is structural — arrays go to form 1, anything with a
 * `register` method goes to form 2, plain objects go to form 3.
 */
export type McpServerPromptsOptions =
  | readonly PromptDeclaration[]
  | Prompts
  | McpServerPromptsConfig;

/**
 * Capability-advertisement opt-OUTS. The harness drives defaults from
 * what's actually wired; this only lets adopters REMOVE a capability
 * that would otherwise be advertised. Setting an entry to `true` is a
 * no-op when the capability isn't wired (no lying on the wire).
 */
export interface McpServerCapabilitiesOptions {
  readonly tools?: boolean;
  readonly prompts?: boolean;
  readonly resources?: boolean;
  readonly elicitation?: boolean;
  /**
   * Pattern-B tasks capability. Advertised when at least one tool
   * declares `taskSupport: "required" | "supported"`. Opt out with
   * `false`.
   */
  readonly tasks?: boolean;
  /**
   * Argument-completion capability. Advertised when the `completions`
   * slot carries at least one handler. Opt out with `false`.
   */
  readonly completions?: boolean;
  /**
   * Structured-logging capability (`notifications/message` +
   * `logging/setLevel`). Advertised ON by default — every MCP request
   * context gets a `ctx.log` sink. Opt out with `false` (drops the
   * capability AND makes `ctx.log` undefined).
   */
  readonly logging?: boolean;
}

/**
 * Argument-completion slot. Maps a prompt name to a per-argument map
 * of {@link CompletionHandler}s — the sugar builders in
 * `@agentick/mcp-next` (`completeFromList`, `completeFromEnum`,
 * `completeDependent`, ...) produce these. When a client issues
 * `completion/complete` for `ref/prompt` + argument name, the matching
 * handler runs; unknown refs / arguments resolve to an empty value
 * list (no protocol error — clients probe freely).
 *
 * Kept as a server-config slot rather than a field on
 * `PromptDeclaration` because argument completion is an MCP-wire
 * concept: the sugar + the 100-cap live at the wire edge, and prompt
 * declarations stay framework-neutral (usable by non-MCP surfaces
 * that have no completion notion).
 */
export interface McpServerCompletionsConfig {
  /**
   * Prompt-argument completion handlers, keyed by prompt name, then by
   * argument name.
   */
  readonly prompts?: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  // TODO(phase-#123): `resourceTemplates` keyed by uriTemplate → variable
  // → handler, once the resource substrate (Wave 4) exists. The
  // CompleteRequestSchema handler already routes `ref/resource` to a
  // no-op empty result until then.
}

/**
 * The completions slot. Currently a single config-object shape (prompt
 * argument handlers); resource-template completion joins it with Wave 4.
 */
export type McpServerCompletionsOptions = McpServerCompletionsConfig;

/**
 * Elicit slot — opt-OUT for `ctx.elicit`. Elicitation is ON by
 * default: tool handlers receive `ctx.elicit` whenever the connected
 * client advertised the `elicitation` capability. The slot only
 * exists to let adopters with specific constraints (audit policies
 * that forbid server-initiated requests, security postures that
 * sandbox server→client communication, etc.) DISABLE it entirely:
 *
 *   elicit: false  →  ctx.elicit is always undefined, even for
 *                     clients that advertised the capability.
 *
 * Per ADR 42 §"What this ADR does NOT decide": elicit is sugar over
 * per-request `sdkServer.request("elicitation/create")` calls, not a
 * harness-backed source. The trichotomy convention does not apply
 * (no declarations / no instance / no shorthand) — boolean opt-out
 * is the right shape.
 *
 * Elicitation is NOT advertised in server capabilities (it's a
 * client-side capability in MCP); the server just issues
 * `elicitation/create` when it wants. The real gate is the client's
 * `initialize`-time capability advertisement — `ctx.elicit` is
 * `undefined` if the client didn't opt in, regardless of server
 * config.
 */
export interface McpServerElicitOptions {
  readonly enabled: boolean;
}

/**
 * Pluggable security stages. Defaults are transport-aware (stdio +
 * in-memory = allowAll; HTTP/WS = localOnly + rejectAll until config
 * provides explicit auth). Adopters override stages individually.
 */
export interface McpServerAuthOptions {
  readonly connectionGuard?: ConnectionGuard;
  readonly authenticator?: Authenticator;
  readonly authorizer?: Authorizer;
  readonly rateLimiter?: RateLimiter;
  readonly inputSanitizer?: InputSanitizer;
}

/**
 * The canonical adopter-facing options shape. Passed to
 * `new McpServerHarness(...)` (or `spawnStandaloneMcpServer`) /
 * `createGateway({ mcpServers: [...] })`.
 */
export interface McpServerOptions {
  /** Unique server name within the gateway. Used in observability + URL routing. */
  readonly name: string;
  /** Listeners. Adopters call factories (`stdioTransport()`, ...) and pass the returned objects. */
  readonly transports: readonly ServerTransport[];
  /** Tool registry + per-connection projection. Absent = tools capability NOT advertised. */
  readonly tools?: McpServerToolsOptions;
  /** Prompts registry + per-connection projection. Absent = prompts capability NOT advertised. Lands #171d. */
  readonly prompts?: McpServerPromptsOptions;
  /**
   * Elicit opt-OUT. Elicitation is ON by default — tool handlers
   * receive `ctx.elicit` whenever the connected client advertised
   * the capability. Set `elicit: false` (or `{ enabled: false }`)
   * to forbid `ctx.elicit` entirely, regardless of client support
   * (audit policies, security postures sandboxing server→client
   * communication). Absent or truthy → default behavior.
   */
  readonly elicit?: boolean | McpServerElicitOptions;
  /**
   * Resources slot — wired when #123 lands. Absent = resources capability
   * NOT advertised.
   * TODO(phase-#123): symmetric with `tools` (#310) and `prompts`
   * (#171d.1) — accept a live catalog and emit
   * `notifications/resources/list_changed` on mutations.
   */
  readonly resources?: unknown;
  /**
   * Argument-completion handlers. Absent = completions capability NOT
   * advertised. Keyed by prompt name → argument name → handler; use
   * the `complete*` sugar builders from `@agentick/mcp-next`.
   */
  readonly completions?: McpServerCompletionsOptions;
  /** Capability opt-OUTS. Defaults derive from what's actually wired. */
  readonly capabilities?: McpServerCapabilitiesOptions;
  /** Security pipeline. Defaults are transport-aware; adopters override stages individually. */
  readonly auth?: McpServerAuthOptions;
  /** Adopter-defined metadata (logging context, deployment tier, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Server identification advertised in `initialize`. Default: `{ name, version: "0.0.0" }`. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

/**
 * Validate + normalize `McpServerOptions`. Throws
 * {@link McpServerConfigInvalid} (concrete subclass of `McpServerError`)
 * on bad input. Returns the input unchanged on success — kept as a
 * separate step so adopters can validate ahead of harness construction
 * (e.g., from a CLI config-load path).
 *
 * Eager: surface bad configs at harness construction time, not at
 * first connection.
 */
export function validateOptions(options: McpServerOptions): McpServerOptions {
  if (typeof options.name !== "string" || options.name.length === 0) {
    throw invalid("name must be a non-empty string", ["name"]);
  }
  if (!Array.isArray(options.transports) || options.transports.length === 0) {
    throw invalid("transports must be a non-empty array", ["transports"]);
  }
  for (const [i, transport] of options.transports.entries()) {
    if (transport == null || typeof transport !== "object") {
      throw invalid(`transports[${i}] must be a ServerTransport object`, ["transports", String(i)]);
    }
    if (typeof (transport as { kind?: unknown }).kind !== "string") {
      throw invalid(`transports[${i}].kind must be a string`, ["transports", String(i), "kind"]);
    }
    if (typeof (transport as { listen?: unknown }).listen !== "function") {
      throw invalid(
        `transports[${i}] is missing listen() — pass the return value of a transport factory (stdioTransport(), httpTransport(), ...)`,
        ["transports", String(i)],
      );
    }
  }
  if (options.tools !== undefined) {
    validateToolsOption(options.tools);
  }
  if (options.prompts !== undefined) {
    validatePromptsOption(options.prompts);
  }
  if (options.elicit !== undefined) {
    if (typeof options.elicit === "boolean") {
      // OK — shorthand.
    } else if (
      typeof options.elicit === "object" &&
      options.elicit !== null &&
      typeof (options.elicit as { enabled?: unknown }).enabled === "boolean"
    ) {
      // OK — explicit config.
    } else {
      throw invalid("elicit must be a boolean or { enabled: boolean }", ["elicit"]);
    }
  }
  if (options.completions !== undefined) {
    validateCompletionsOption(options.completions);
  }
  if (
    options.capabilities !== undefined &&
    options.capabilities !== null &&
    typeof options.capabilities !== "object"
  ) {
    throw invalid("capabilities must be an object", ["capabilities"]);
  }
  if (options.auth !== undefined && options.auth !== null && typeof options.auth !== "object") {
    throw invalid("auth must be an object", ["auth"]);
  }
  return options;
}

function invalid(reason: string, path?: readonly string[]): McpServerConfigInvalid {
  return new McpServerConfigInvalid(path ? { reason, path } : { reason });
}

/**
 * Internal-shape view onto a resolved {@link McpServerPromptsOptions} —
 * the harness consumes this. Resolution happens via
 * {@link resolvePromptsOption}.
 */
export interface ResolvedPromptsOptions {
  readonly declarations: readonly PromptDeclaration[];
  readonly use: Prompts | null;
  readonly filter: PromptsFilter | null;
}

/**
 * Normalize the prompts option into its internal resolved shape. Throws
 * {@link McpServerConfigInvalid} on shape violations. Uses
 * `isPromptsInstance` from `@agentick/spec-next` (the canonical
 * structural guard) — no local duplicate.
 */
export function resolvePromptsOption(option: McpServerPromptsOptions): ResolvedPromptsOptions {
  if (Array.isArray(option)) {
    return { declarations: option, use: null, filter: null };
  }
  if (isPromptsInstance(option)) {
    return { declarations: [], use: option, filter: null };
  }
  const cfg = option as McpServerPromptsConfig;
  const hasDecls = cfg.declarations !== undefined;
  const hasUse = cfg.use !== undefined;
  if (hasDecls && hasUse) {
    throw invalid("prompts config must not set both `declarations` and `use`", ["prompts"]);
  }
  if (!hasDecls && !hasUse) {
    throw invalid("prompts config must set either `declarations` or `use`", ["prompts"]);
  }
  if (hasUse && !isPromptsInstance(cfg.use)) {
    throw invalid("prompts.use must be a Prompts instance", ["prompts", "use"]);
  }
  if (hasDecls && !Array.isArray(cfg.declarations)) {
    throw invalid("prompts.declarations must be an array", ["prompts", "declarations"]);
  }
  return {
    declarations: cfg.declarations ?? [],
    use: cfg.use ?? null,
    filter: cfg.filter ?? null,
  };
}

function validatePromptsOption(option: McpServerPromptsOptions): void {
  // Resolve to surface shape errors at validation time; discard result
  // (the harness re-resolves at construction time).
  resolvePromptsOption(option);
}

/**
 * Normalize the `elicit` slot to a boolean (true = ctx.elicit
 * available when client supports). ON by default; only an explicit
 * `false` or `{ enabled: false }` opts out.
 */
export function resolveElicitOption(option: boolean | McpServerElicitOptions | undefined): boolean {
  if (option === undefined) return true;
  if (typeof option === "boolean") return option;
  return option.enabled;
}

/**
 * Internal-shape view onto a resolved {@link McpServerCompletionsOptions}.
 * The projection layer consumes `prompts` directly; `hasHandlers`
 * drives whether the `completions` capability is advertised.
 */
export interface ResolvedCompletionsOptions {
  readonly prompts: Readonly<Record<string, Readonly<Record<string, CompletionHandler>>>>;
  readonly hasHandlers: boolean;
}

/**
 * Normalize the completions option into its internal resolved shape.
 * Throws {@link McpServerConfigInvalid} on shape violations. `hasHandlers`
 * is `true` iff at least one prompt carries at least one argument
 * handler — the gate for advertising the `completions` capability.
 */
export function resolveCompletionsOption(
  option: McpServerCompletionsOptions,
): ResolvedCompletionsOptions {
  const prompts = option.prompts ?? {};
  let hasHandlers = false;
  for (const argMap of Object.values(prompts)) {
    if (Object.keys(argMap).length > 0) {
      hasHandlers = true;
      break;
    }
  }
  return { prompts, hasHandlers };
}

function validateCompletionsOption(option: McpServerCompletionsOptions): void {
  if (typeof option !== "object" || option === null) {
    throw invalid("completions must be an object", ["completions"]);
  }
  if (option.prompts !== undefined) {
    if (typeof option.prompts !== "object" || option.prompts === null) {
      throw invalid("completions.prompts must be an object keyed by prompt name", [
        "completions",
        "prompts",
      ]);
    }
    for (const [promptName, argMap] of Object.entries(option.prompts)) {
      if (typeof argMap !== "object" || argMap === null) {
        throw invalid(
          `completions.prompts.${promptName} must be an object keyed by argument name`,
          ["completions", "prompts", promptName],
        );
      }
      for (const [argName, handler] of Object.entries(argMap)) {
        if (typeof handler !== "function") {
          throw invalid(
            `completions.prompts.${promptName}.${argName} must be a CompletionHandler function`,
            ["completions", "prompts", promptName, argName],
          );
        }
      }
    }
  }
}

/**
 * Internal-shape view onto a resolved {@link McpServerToolsOptions} —
 * the harness consumes this. Resolution happens via
 * {@link resolveToolsOption}.
 *
 * Both forms (array shorthand, config object) collapse to the same
 * pair: a canonical declarations registry and a `handlerRef → handler`
 * resolver. The projection layer (`installToolsHandlers`) consumes
 * exactly these two values, plus the projection rules.
 */
export interface ResolvedToolsOptions {
  /**
   * Canonical tool-declaration source. Always a {@link ToolCatalog} —
   * static arrays supplied by adopters wrap via `staticToolCatalog`;
   * dynamic sources feed reactivity to
   * `notifications/tools/list_changed` on the MCP wire.
   * Per-connection filter + transforms apply on top of `.list()`.
   */
  readonly registry: ToolCatalog;
  /**
   * Pattern-B-aware handler resolver. Returns the projection-internal
   * discriminated union — `kind: "inline"` for the common case
   * (returns `ContentBlock[]`), `kind: "task"` when the handler
   * returned a `TaskHandle` (Pattern B over MCP, #171d.3). Returns
   * `null` for unknown handlerRefs (the projection surfaces this as
   * a tool-not-found `CallToolResult`).
   */
  readonly resolveHandler: ToolHandlerResolver;
  /** Per-connection visibility predicate. */
  readonly filter: ToolsFilter | null;
  /** Per-connection name / metadata / schema transforms. */
  readonly transforms: readonly ToolTransform<McpRequestContext>[];
}

/**
 * Normalize the tools option into its internal resolved shape. Throws
 * {@link McpServerConfigInvalid} on shape violations.
 *
 * Both forms — array shorthand and config object — collapse to the
 * same pair `{ registry, resolveHandler }`. The handler is invoked
 * with the LIVE `McpRequestContext` (ADR 43: same shape as in-process
 * `ToolHandlerCtx`, just discriminated by `transport: "mcp"`).
 */
export function resolveToolsOption(option: McpServerToolsOptions): ResolvedToolsOptions {
  if (Array.isArray(option)) {
    return resolveFromCreatedTools(option, null, []);
  }
  const cfg = option as McpServerToolsConfig;
  const hasTools = cfg.tools !== undefined;
  const hasRegistry = cfg.registry !== undefined;
  const hasResolver = cfg.resolveHandler !== undefined;
  if (hasTools && (hasRegistry || hasResolver)) {
    throw invalid(
      "tools config must not mix `tools` with `registry`/`resolveHandler` — pick one authoring pattern",
      ["tools"],
    );
  }
  if (hasRegistry !== hasResolver) {
    throw invalid("tools config must supply BOTH `registry` and `resolveHandler` together", [
      "tools",
    ]);
  }
  if (!hasTools && !hasRegistry) {
    throw invalid(
      "tools config must supply either `tools: CreatedTool[]` OR `registry`+`resolveHandler`",
      ["tools"],
    );
  }
  if (hasTools) {
    if (!Array.isArray(cfg.tools)) {
      throw invalid("tools.tools must be an array of CreatedTool", ["tools", "tools"]);
    }
    return resolveFromCreatedTools(cfg.tools, cfg.filter ?? null, cfg.transforms ?? []);
  }
  // hasRegistry === true
  if (typeof cfg.resolveHandler !== "function") {
    throw invalid("tools.resolveHandler must be a function", ["tools", "resolveHandler"]);
  }
  // Accept either a static array (wrapped via staticToolCatalog) or a
  // live ToolCatalog (used directly). Live catalogs propagate their
  // change notifications to `sendToolListChanged` at connection scope.
  let registry: ToolCatalog;
  if (Array.isArray(cfg.registry)) {
    registry = staticToolCatalog(cfg.registry);
  } else if (isToolCatalog(cfg.registry)) {
    registry = cfg.registry;
  } else {
    throw invalid(
      "tools.registry must be a ToolDeclaration[] or a ToolCatalog (from @agentick/tool-next)",
      ["tools", "registry"],
    );
  }
  return {
    registry,
    resolveHandler: cfg.resolveHandler,
    filter: cfg.filter ?? null,
    transforms: cfg.transforms ?? [],
  };
}

function resolveFromCreatedTools(
  created: readonly CreatedTool[],
  filter: ToolsFilter | null,
  transforms: readonly ToolTransform<McpRequestContext>[],
): ResolvedToolsOptions {
  const registry: ToolDeclaration[] = [];
  const handlersByRef = new Map<string, CreatedTool["handler"]>();
  for (const [i, t] of created.entries()) {
    if (!isCreatedTool(t)) {
      throw invalid(
        `tools[${i}] is not a CreatedTool (missing handler / handlerRef / declaration)`,
        ["tools", String(i)],
      );
    }
    registry.push(t.declaration);
    handlersByRef.set(t.handlerRef, t.handler);
  }
  const resolveHandler: ResolvedToolsOptions["resolveHandler"] = (handlerRef) => {
    const h = handlersByRef.get(handlerRef);
    if (!h) return null;
    return async (input, ctx) => {
      // ADR 43: McpRequestContext IS a ToolHandlerCtx (with
      // `transport: "mcp"` discriminator). Pass directly; no stub /
      // adapter needed.
      const result = await h(input, { ctx, use: {} });
      if (Array.isArray(result)) {
        return { kind: "inline", content: result };
      }
      // Pattern B (#171d.3) — the handler returned a TaskHandle (via
      // `ctx.tasks!.submit(...)`). The projection layer registers the
      // handle in the per-connection server-task registry, returns
      // CreateTaskResult on the wire, and emits
      // `notifications/tasks/status` as the task progresses.
      if (isTaskHandle(result)) {
        return { kind: "task", handle: result };
      }
      // ToolHandlerResult can also be Promise<ContentBlock[]> /
      // Effect<...>. The MCP server projection doesn't speak Effect
      // yet — Effect handlers + Promise<ContentBlock[]> handlers land
      // with downstream integration.
      throw new Error(
        "MCP-server tool handlers must return either ContentBlock[] (inline) " +
          "or a TaskHandle (Pattern B via ctx.tasks!.submit). Effect handlers " +
          "are deferred.",
      );
    };
  };
  return { registry: staticToolCatalog(registry), resolveHandler, filter, transforms };
}

function validateToolsOption(option: McpServerToolsOptions): void {
  // Resolve to surface shape errors at validation time; discard
  // result (the harness re-resolves at construction time).
  resolveToolsOption(option);
}
