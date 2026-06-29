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

import type { McpRequestContext, McpServerError, ToolDeclaration } from "@agentick/spec-next";
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
 * Per-connection prompts projection. Same shape pattern as tools —
 * canonical registry + per-connection filter. Lands with #171d when
 * the prompts projection module is wired.
 */
export interface McpServerPromptsOptions {
  /** Canonical prompts registry — populated by `@agentick/prompts-next`. */
  readonly registry?: unknown;
  readonly filter?: (decl: unknown, ctx: McpRequestContext) => boolean;
}

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
 * `McpServerConfigInvalid` (POJO discriminated union member of
 * `McpServerError`) on bad input. Returns the input unchanged on
 * success — kept as a separate step so adopters can validate ahead
 * of harness construction (e.g., from a CLI config-load path).
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

function invalid(reason: string, path?: readonly string[]): McpServerError {
  return {
    _tag: "McpServerConfigInvalid" as const,
    reason,
    ...(path ? { path } : {}),
  };
}
