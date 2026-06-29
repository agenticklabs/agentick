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
  McpServerConfigInvalid,
  type McpRequestContext,
  type PromptDeclaration,
  type Prompts,
  type ToolDeclaration,
} from "@agentick/spec-next";
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

/**
 * Per-connection tool projection rules. Applied per request against
 * the live {@link McpRequestContext} (post-authenticator), NOT pre-
 * baked at connection setup. A tool hidden by `filter` cannot be
 * called either — the projection re-applies at `tools/call`.
 */
export interface McpServerToolsOptions {
  /** Canonical registry — what tools exist on this server. */
  readonly registry: readonly ToolDeclaration[];
  /** Resolves a `handlerRef` to the concrete async handler. */
  readonly resolveHandler: ToolHandlerResolver;
  /** Per-connection visibility predicate. */
  readonly filter?: (tool: ToolDeclaration, ctx: McpRequestContext) => boolean;
  /** Per-connection name / metadata / schema transforms. Applied left-to-right. */
  readonly transforms?: readonly ToolTransform<McpRequestContext>[];
}

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
}

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
  /** Resources slot — wired when #123 lands. Absent = resources capability NOT advertised. */
  readonly resources?: unknown;
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
    if (typeof options.tools !== "object" || options.tools === null) {
      throw invalid("tools must be an object", ["tools"]);
    }
    if (!Array.isArray(options.tools.registry)) {
      throw invalid("tools.registry must be an array", ["tools", "registry"]);
    }
    if (typeof options.tools.resolveHandler !== "function") {
      throw invalid("tools.resolveHandler must be a function", ["tools", "resolveHandler"]);
    }
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
 * Structural detector for a `Prompts` instance. We don't `instanceof
 * PromptsHarness` because the spec slot is typed against the protocol,
 * not the concrete class (adopters may supply stubs, decorated
 * variants, etc.).
 */
function isPromptsInstance(value: unknown): value is Prompts {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { register?: unknown }).register === "function" &&
    typeof (value as { list?: unknown }).list === "function" &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { subscribeAll?: unknown }).subscribeAll === "function"
  );
}

/**
 * Normalize the prompts option into its internal resolved shape. Throws
 * {@link McpServerConfigInvalid} on shape violations.
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
