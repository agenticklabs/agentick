/**
 * Prompts projection — per-connection `prompts/list` + `prompts/get`,
 * plus `notifications/prompts/list_changed` driven by the
 * `PromptsHarness` change-notifier.
 *
 * The harness owns prompt mutation (register/update/remove). The
 * server harness only PROJECTS — it never mutates the registry.
 *
 * Each handler declares a CROSSING (ADR 92 §Slice A) whose `runCrossing`
 * owns admission, the `mcp:command:<verb>` envelope, the security stages on
 * the guard seam, and the ctx mint. This module keeps the projection work:
 *
 *   1. Apply the per-connection `filter` over the canonical declarations.
 *   2. For `prompts/list`, return the projected list.
 *   3. For `prompts/get`, render via `source.fx.render(...)` composed on the
 *      crossing's fiber (ADR 92 §Slice A — so `prompts:command:render` is a
 *      CHILD of the crossing and the declaration's `render(args, ctx)` sees the
 *      caller's identity) and map the resulting `MessageEntry[]` to MCP's
 *      `PromptMessage[]` wire form.
 *
 * MCP `PromptMessage.role` is restricted to `"user" | "assistant"` —
 * v2's `MessageRole` is broader. We map:
 *   - `user` / `assistant` → carried through
 *   - `system` / `grounding` → `user` (instruction context, which MCP has no
 *     role for; consistent with how clients consume `prompts/get`, and with
 *     what Anthropic and Google adapters do with the same roles). A
 *     free-floating `<Section>` in a JSX prompt body arrives as `grounding`
 *     (ADR 94), so dropping it would silently empty such a prompt.
 *   - `tool` / `event` / other → skipped (don't make sense in prompts/get)
 *
 * Message CONTENT narrows through the shared outbound mapper
 * (`protocol/content.ts`) — `PromptMessage.content` is the same
 * five-member union a `tools/call` result carries, so both projections
 * use one mapping.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  GetPromptRequest,
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  Prompt as McpWirePrompt,
  PromptMessage as McpWirePromptMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpRequestContext,
  MessageEntry,
  PromptDeclaration,
  Prompts,
  PromptsGetResult,
} from "@agentick/spec";
import type { Unsubscribe } from "@agentick/runtime";
import { paginate } from "@agentick/utils";

import { toWireContentBlock } from "../../protocol/content.js";
import {
  readMcpDeclarationExtensions,
  readMetadataIcons,
  readMetadataTitle,
} from "../wire-extensions.js";
import type { McpHandlerExtra, RunCrossing } from "./crossing.js";

export interface PromptsProjectionOptions {
  /** Prompts source whose registry is projected onto the wire. */
  readonly source: Prompts;
  /** Per-connection visibility predicate. Hidden prompts cannot be fetched either. */
  readonly filter?: (decl: PromptDeclaration, ctx: McpRequestContext) => boolean;
  /** The crossing-operation runner for this connection (ADR 92 §Slice A). */
  readonly runCrossing: RunCrossing;
}

/**
 * Install `prompts/list` + `prompts/get` request handlers on an SDK
 * Server, and subscribe to the harness change-notifier to emit
 * `notifications/prompts/list_changed` on every register/update/remove.
 *
 * Returns an `Unsubscribe` — call it from the connection close path
 * to stop the change-notification fan-out for this connection.
 */
export function installPromptsHandlers(
  sdkServer: SdkServer,
  options: PromptsProjectionOptions,
): Unsubscribe {
  const filter = options.filter;

  // ─────────── prompts/list ───────────
  sdkServer.setRequestHandler(
    ListPromptsRequestSchema,
    async (request: ListPromptsRequest, extra: McpHandlerExtra): Promise<ListPromptsResult> =>
      options.runCrossing({
        verb: "list-prompts",
        operation: { type: "prompt_list" },
        signal: extra.signal,
        run: async (_input, ctx): Promise<ListPromptsResult> => {
          // Paginate AFTER the per-connection filter: pages must be cut from what
          // THIS connection can see. A catalog at or under the page size is
          // byte-identical to the unpaginated reply (no `nextCursor` key).
          const projected = projectPrompts(options.source.list(), filter, ctx);
          const { page, nextCursor } = paginate(projected, request.params?.cursor);
          const result: ListPromptsResult = { prompts: page.map(toWirePrompt) };
          if (nextCursor !== undefined) result.nextCursor = nextCursor;
          return result;
        },
      }),
  );

  // ─────────── prompts/get ───────────
  sdkServer.setRequestHandler(
    GetPromptRequestSchema,
    async (request: GetPromptRequest, extra: McpHandlerExtra): Promise<GetPromptResult> =>
      options.runCrossing({
        verb: "get-prompt",
        operation: { type: "prompt_get", name: request.params.name },
        params: { name: request.params.name },
        signal: extra.signal,
        run: async (_input, ctx, onFiber): Promise<GetPromptResult> => {
          // Re-project so per-connection filter decides visibility for
          // this specific get. A prompt hidden from `list` must not be
          // fetchable via `get` either — symmetric to the tools-projection
          // re-check on call.
          const projected = projectPrompts(options.source.list(), filter, ctx);
          const found = projected.find((p) => p.name === request.params.name);
          if (!found) {
            // Match v1's wire shape: throw a JSON-RPC error with code -32602
            // (invalid params) so clients see the canonical "no such prompt"
            // failure. The SDK serialiser maps thrown errors with `.code` to
            // their JSON-RPC equivalent.
            throw Object.assign(new Error(`Unknown prompt: ${request.params.name}`), {
              code: -32602,
            });
          }

          // ON THE CROSSING'S FIBER (ADR 92 §Slice A): `prompts:command:render`
          // runs as a CHILD of this crossing, so the declaration's
          // `render(args, ctx)` receives an `OperationCtx` carrying the caller's
          // identity + the connection dim. Through the Promise facade the render
          // re-entered Effect on a fresh root fiber and saw neither.
          //
          // ADR 91 — `render(args, ctx)` receives the REDACTED trunk identity
          // (`ctx.identity`, what the journal records) PLUS the `mcp` boundary
          // facet (`ctx.mcp.user`, the caller's authenticated record with its
          // credential) — in-fiber only, never serialized. The crossing publishes
          // it via `withBoundaryFacets`; `currentOperationCtx` folds it in as
          // `deriveContext`'s extras.
          const result: PromptsGetResult = await onFiber(
            options.source.fx.render({
              name: request.params.name,
              ...(request.params.arguments ? { args: request.params.arguments } : {}),
            }),
          );

          // `GetPromptResult._meta` — sourced from the render result's
          // `metadata` bag, which the harness fills with the DECLARATION's own
          // (spec `PromptsGetResult.metadata`). Same reader as `prompts/list`
          // because it is the same bag under the same key: one authored place
          // reaching both wire slots. A prompt whose declaration carries no
          // `mcp` block projects byte-identically to before.
          const meta = readMcpDeclarationExtensions(result.metadata)?.meta;
          return {
            description: result.description,
            messages: result.messages.flatMap(toWirePromptMessages),
            ...(meta !== undefined ? { _meta: meta } : {}),
          };
        },
      }),
  );

  // ─────────── notifications/prompts/list_changed ───────────
  // The SDK only sends the notification when the connection has fully
  // initialized and the client advertised `prompts.listChanged`
  // support. The SDK does the gating; we just call sendPromptListChanged
  // on every harness change.
  const unsubscribe = options.source.subscribeAll(() => {
    void sdkServer.sendPromptListChanged().catch(() => {
      // Connection probably closed mid-notification — silently drop.
      // The harness change still happened; future connections will see
      // the new list state via `prompts/list`.
    });
  });
  return unsubscribe;
}

/**
 * Apply the per-connection filter to the canonical declarations. No
 * transforms here (yet) — adopters that need name/description
 * customization per-connection can wrap the harness or wait for the
 * `@agentick/prompts/transforms` follow-up.
 */
export function projectPrompts(
  declarations: readonly PromptDeclaration[],
  filter: PromptsProjectionOptions["filter"] | undefined,
  ctx: McpRequestContext,
): readonly PromptDeclaration[] {
  return filter ? declarations.filter((p) => filter(p, ctx)) : declarations;
}

/**
 * Convert a v2 `PromptDeclaration` to the MCP wire `Prompt` shape.
 * MCP arguments only carry `{name, description, required}`; v2's
 * Standard-Schema validator is server-side only.
 *
 * Display + extension fields follow the same conventions the tools
 * projection uses (`toWireTool`):
 *   - `decl.title` → wire `title` (the FIRST-CLASS field; a prompt has
 *     one on the declaration, unlike a tool). `metadata.title` overrides
 *     it, so a per-connection transform can relabel without touching the
 *     declaration.
 *   - `metadata.icons` → wire `icons`
 *   - `metadata.mcp.meta` → wire `_meta` ({@link McpDeclarationExtensions})
 * Absent ⇒ the field is not emitted (byte-identical to before).
 */
export function toWirePrompt(decl: PromptDeclaration): McpWirePrompt {
  const wire: McpWirePrompt = { name: decl.name, description: decl.description };
  const title = readMetadataTitle(decl.metadata) ?? decl.title;
  if (title !== undefined) wire.title = title;
  const icons = readMetadataIcons(decl.metadata);
  if (icons !== undefined) wire.icons = icons as McpWirePrompt["icons"];
  const meta = readMcpDeclarationExtensions(decl.metadata)?.meta;
  if (meta !== undefined) wire._meta = meta as McpWirePrompt["_meta"];
  if (decl.arguments && decl.arguments.length > 0) {
    wire.arguments = decl.arguments.map((arg) => {
      const out: NonNullable<McpWirePrompt["arguments"]>[number] = { name: arg.name };
      if (arg.description !== undefined) out.description = arg.description;
      if (arg.required !== undefined) out.required = arg.required;
      return out;
    });
  }
  return wire;
}

/**
 * Convert one `MessageEntry` to zero-or-more MCP `PromptMessage`s.
 * Roles that don't map to MCP get filtered out (returns `[]`).
 * Multi-block messages produce one PromptMessage per block.
 *
 * Content narrows through {@link toWireContentBlock} — the SAME mapper
 * the `tools/call` result projection uses, because `PromptMessage.content`
 * is the same five-member MCP union. An image survives as an image
 * instead of becoming a JSON blob.
 */
export function toWirePromptMessages(entry: MessageEntry): readonly McpWirePromptMessage[] {
  const role = mapRole(entry.role);
  if (role === null) return [];
  return entry.content.map((block) => ({ role, content: toWireContentBlock(block) }));
}

function mapRole(role: string): "user" | "assistant" | null {
  if (role === "user" || role === "assistant") return role;
  if (role === "system" || role === "grounding") return "user";
  return null;
}
