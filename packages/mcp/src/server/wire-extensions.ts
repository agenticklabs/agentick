/**
 * MCP wire extensions — the ONE typed convention for carrying
 * MCP-specific payloads that v2's shared declarations (`ToolDeclaration`,
 * `PromptDeclaration`, `ResourceDescriptor`) and `ToolResultEnvelope`
 * don't natively model.
 *
 * Wire constraints live at the wire. v2's spec is deliberately
 * provider-agnostic: every declaration carries an open `metadata` bag,
 * and MCP-specific payloads ride through it under a single namespaced
 * key (`metadata.mcp`), projected onto the MCP wire here — never leaking
 * MCP vocabulary into the shared substrate.
 *
 * Four carriage sites, one key:
 *
 *   - **Tool declaration** — `ToolDeclaration.metadata.mcp` carries
 *     {@link McpToolDeclarationExtensions} (`meta` + `annotations`).
 *     `toWireTool` projects them onto the wire `Tool._meta` and
 *     `Tool.annotations` (`projection/tools.ts`).
 *   - **Tool result** — a `ToolResultEnvelope.metadata.mcp` carries
 *     {@link McpToolResultExtensions} (`meta`). The CreatedTool wrapper
 *     (`config.ts`) reads it off the normalized result and the tools
 *     projection spreads it onto the wire `CallToolResult._meta`.
 *   - **Prompt declaration** — `PromptDeclaration.metadata.mcp` carries
 *     {@link McpDeclarationExtensions} (`meta`); `toWirePrompt` projects
 *     it onto `Prompt._meta` (`projection/prompts.ts`).
 *   - **Resource descriptor** — `ResourceDescriptor.metadata.mcp` (and a
 *     template descriptor's) carries the same shape; `toWireResource` /
 *     `toWireResourceTemplate` project it onto `Resource._meta`
 *     (`projection/resources.ts`).
 *
 * `metadata.title` / `metadata.icons` are a SEPARATE, older convention
 * (see `@agentick/tool/transforms/describe.ts`) shared by all four sites
 * and read directly by each projection — they are display fields with
 * first-class wire slots, not MCP-specific payloads.
 *
 * The convention runs BOTH directions on the same key: when agentick
 * CONSUMES an MCP server, `mapCallToolResult` (`integration/content-
 * mapper.ts`) folds the incoming `CallToolResult._meta` into
 * `metadata.mcp.meta` via {@link mcpResultExtensions}, so a result-scoped
 * payload — an MCP-Apps `ui` descriptor, a step-up challenge — reads the
 * same whether agentick produced it or received it.
 *
 * Adopters never hand-write the `mcp` key — {@link mcpToolExtensions}
 * (declaration) and {@link mcpResultExtensions} (result) build the
 * `metadata` fragment. Absent extensions ⇒ wire output byte-identical
 * to a tool that carried none (the regression guarantee).
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 * @see wwwAuthenticateMeta (security/www-authenticate.ts) — the canonical
 *   result-side `_meta` producer (RFC 6750 step-up challenge).
 */

/**
 * The single namespaced key under a `metadata` bag holding MCP wire
 * extensions. One key, shared by the declaration and result carriage
 * sites (the value shapes differ per site — see the two extension
 * interfaces below).
 */
export const MCP_METADATA_KEY = "mcp" as const;

/**
 * MCP advisory annotation hints, projected onto the wire `Tool.annotations`.
 * These are ADVISORY: clients render them (a read-only badge, a
 * destructive-action confirm) but the MCP spec does not require servers to
 * enforce them. Mirrors the MCP `ToolAnnotations` boolean hints (v1 parity).
 *
 *   - `readOnlyHint`     — the tool does not mutate its environment.
 *   - `destructiveHint`  — the tool may perform destructive updates (only
 *     meaningful when `readOnlyHint` is false/absent).
 *   - `idempotentHint`   — repeated calls with the same args have no
 *     additional effect (only meaningful when not read-only).
 *   - `openWorldHint`    — the tool interacts with an open/unbounded world
 *     (web search, external APIs) vs. a closed domain (memory, math).
 *
 * `title` is deliberately NOT modeled here: the wire `Tool.title` is
 * carried by the established `metadata.title` convention (see
 * `toWireTool`); duplicating it inside `annotations.title` would create
 * two sources of truth for the same wire field.
 */
export interface McpToolAnnotationHints {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * Declaration-side MCP extensions carried under
 * `ToolDeclaration.metadata.mcp`, projected onto the wire `Tool`.
 */
export interface McpToolDeclarationExtensions {
  /**
   * Free-form `_meta` projected verbatim onto the wire `Tool._meta`.
   * This is where the MCP Apps extension's `ui://` template linkage lives
   * (e.g. `{ "openai/outputTemplate": "ui://widget/invoice-list" }`), and
   * any other declaration-scoped `_meta` a client understands.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Advisory hints projected onto the wire `Tool.annotations`. */
  readonly annotations?: McpToolAnnotationHints;
}

/**
 * Result-side MCP extensions carried under a
 * `ToolResultEnvelope.metadata.mcp`, projected onto the wire
 * `CallToolResult`.
 */
export interface McpToolResultExtensions {
  /**
   * Free-form `_meta` projected verbatim onto the wire
   * `CallToolResult._meta`. The canonical producer is
   * {@link wwwAuthenticateMeta} (mid-session step-up auth); any
   * result-scoped `_meta` a client understands rides here.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * The `metadata` fragment shape both helpers produce — a single
 * namespaced `mcp` key whose value is the site-specific extensions.
 */
export type McpMetadataFragment<T> = { readonly [MCP_METADATA_KEY]: T };

/**
 * Build the `metadata` fragment carrying declaration-side MCP extensions.
 * Merge (or spread) the result into `createTool({ metadata })` — never
 * hand-write the `mcp` key.
 *
 * @example
 *   createTool({
 *     name: "search_invoices",
 *     description: "Search invoices (read-only).",
 *     input: schema,
 *     handler,
 *     metadata: mcpToolExtensions({
 *       annotations: { readOnlyHint: true, openWorldHint: false },
 *       meta: { "openai/outputTemplate": "ui://widget/invoice-list" },
 *     }),
 *   });
 */
export function mcpToolExtensions(
  ext: McpToolDeclarationExtensions,
): McpMetadataFragment<McpToolDeclarationExtensions> {
  return { [MCP_METADATA_KEY]: ext };
}

/**
 * Build the `metadata` fragment carrying result-side MCP extensions.
 * Set it as a tool result envelope's `metadata` — never hand-write the
 * `mcp` key.
 *
 * @example
 *   return {
 *     content: [{ type: "text", text: "Re-authentication required." }],
 *     isError: true,
 *     metadata: mcpResultExtensions({
 *       meta: wwwAuthenticateMeta({ scope: "invoices:write", error: "insufficient_scope" }),
 *     }),
 *   };
 */
export function mcpResultExtensions(
  ext: McpToolResultExtensions,
): McpMetadataFragment<McpToolResultExtensions> {
  return { [MCP_METADATA_KEY]: ext };
}

/**
 * Read declaration-side MCP extensions out of a `ToolDeclaration.metadata`
 * bag. Returns `undefined` when the tool carries none (or a malformed
 * `mcp` value), so the projection emits a byte-identical wire `Tool`.
 */
export function readMcpToolExtensions(
  metadata: Readonly<Record<string, unknown>> | undefined,
): McpToolDeclarationExtensions | undefined {
  const block = metadata?.[MCP_METADATA_KEY];
  if (typeof block !== "object" || block === null) return undefined;
  return block as McpToolDeclarationExtensions;
}

/**
 * Read result-side MCP extensions out of a normalized result's `metadata`
 * bag. Returns `undefined` when the result carried none (or a malformed
 * `mcp` value), so the projection emits a byte-identical
 * `CallToolResult`.
 */
export function readMcpResultExtensions(
  metadata: Readonly<Record<string, unknown>> | undefined,
): McpToolResultExtensions | undefined {
  const block = metadata?.[MCP_METADATA_KEY];
  if (typeof block !== "object" || block === null) return undefined;
  return block as McpToolResultExtensions;
}

// ============================================================================
// Prompts + resources — same key, `meta` only
// ============================================================================

/**
 * MCP extensions for a declaration whose only wire extension point is
 * `_meta`: a prompt (`Prompt._meta`) or a resource / resource-template
 * descriptor (`Resource._meta`, `ResourceTemplate._meta`).
 *
 * Tools take {@link McpToolDeclarationExtensions} instead — they alone
 * have an `annotations` hint block on the wire.
 */
export interface McpDeclarationExtensions {
  /**
   * Free-form `_meta` projected verbatim onto the wire record's `_meta`.
   * An MCP Apps `ui://` template linkage on a prompt, a client-understood
   * descriptor on a resource — anything declaration-scoped rides here.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Build the `metadata` fragment carrying a prompt's MCP extensions. Spread
 * it into the declaration's `metadata` — never hand-write the `mcp` key.
 *
 * @example
 *   prompts.register({
 *     name: "jobs_over_budget",
 *     description: "Jobs over their budget.",
 *     metadata: {
 *       title: "Jobs Over Budget",
 *       ...mcpPromptExtensions({ meta: { "openai/outputTemplate": "ui://widget/jobs" } }),
 *     },
 *   });
 */
export function mcpPromptExtensions(
  ext: McpDeclarationExtensions,
): McpMetadataFragment<McpDeclarationExtensions> {
  return { [MCP_METADATA_KEY]: ext };
}

/**
 * Build the `metadata` fragment carrying a resource (or resource-template)
 * descriptor's MCP extensions. Same key, same shape as
 * {@link mcpPromptExtensions} — named separately so the call site reads as
 * the surface it decorates.
 */
export function mcpResourceExtensions(
  ext: McpDeclarationExtensions,
): McpMetadataFragment<McpDeclarationExtensions> {
  return { [MCP_METADATA_KEY]: ext };
}

/**
 * Read the `meta`-only MCP extensions off a prompt / resource descriptor's
 * `metadata` bag. Returns `undefined` when it carries none (or a malformed
 * `mcp` value), so the projection emits a byte-identical wire record.
 */
export function readMcpDeclarationExtensions(
  metadata: Readonly<Record<string, unknown>> | undefined,
): McpDeclarationExtensions | undefined {
  const block = metadata?.[MCP_METADATA_KEY];
  if (typeof block !== "object" || block === null) return undefined;
  return block as McpDeclarationExtensions;
}

/**
 * Read the shared `metadata.icons` display convention off any declaration
 * bag, in the wire's icon shape. One reader for all four projections —
 * tools, prompts, resources, resource templates.
 *
 * The convention is structural (`describe.ts`'s `IconDescriptor`), so a
 * malformed value is dropped rather than emitted onto the wire.
 *
 * A pass-through with no per-field mapping, and that is the point: the
 * convention's field types now match `Icon`'s exactly (`sizes` is `string[]` on
 * both sides since #259). Were they to diverge again, four projection sites
 * would each need the same fix-up — the reason the convention moved rather than
 * the wire.
 *
 * @verifiedBy packages/mcp/src/server/__tests__/wire-extensions.spec.ts
 *   §"projected icons parse under the SDK Icon schema"
 */
export function readMetadataIcons(
  metadata: Readonly<Record<string, unknown>> | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const icons = metadata?.icons;
  return Array.isArray(icons) ? (icons as readonly Readonly<Record<string, unknown>>[]) : undefined;
}

/**
 * Read the shared `metadata.title` display convention off any declaration
 * bag. `undefined` when absent or not a string.
 */
export function readMetadataTitle(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const title = metadata?.title;
  return typeof title === "string" ? title : undefined;
}
