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
 *   3. For `prompts/get`, render via `harness.render(...)` and map the
 *      resulting `MessageEntry[]` to MCP's `PromptMessage[]` wire form.
 *
 * MCP `PromptMessage.role` is restricted to `"user" | "assistant"` —
 * v2's `MessageRole` is broader. We map:
 *   - `user` / `assistant` → carried through
 *   - `system` → `user` (treats the system instruction as user context;
 *     consistent with v1 and how clients typically consume `prompts/get`)
 *   - `tool` / `event` / other → skipped (don't make sense in prompts/get)
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
  ContentBlock,
  McpRequestContext,
  MessageEntry,
  PromptDeclaration,
  Prompts,
  PromptsGetResult,
} from "@agentick/spec";
import { isTextBlock } from "@agentick/spec";
import type { Unsubscribe } from "@agentick/runtime";

import type { RunCrossing } from "./crossing.js";

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
    async (_request: ListPromptsRequest): Promise<ListPromptsResult> =>
      options.runCrossing({
        verb: "list-prompts",
        operation: { type: "prompt_list" },
        run: async (_input, ctx): Promise<ListPromptsResult> => {
          const projected = projectPrompts(options.source.list(), filter, ctx);
          return { prompts: projected.map(toWirePrompt) };
        },
      }),
  );

  // ─────────── prompts/get ───────────
  sdkServer.setRequestHandler(
    GetPromptRequestSchema,
    async (request: GetPromptRequest): Promise<GetPromptResult> =>
      options.runCrossing({
        verb: "get-prompt",
        operation: { type: "prompt_get", name: request.params.name },
        params: { name: request.params.name },
        run: async (_input, ctx): Promise<GetPromptResult> => {
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

          // TODO(ADR-92 slice-A): `Prompts.render` re-enters Effect on a fresh
          // root fiber, so the declaration's `render(args, ctx?)` still receives
          // the prompts harness's own op ctx — NOT this crossing's identity. Same
          // wall as the resources read; see the resources/prompts stop-rule.
          const result: PromptsGetResult = await options.source.render({
            name: request.params.name,
            ...(request.params.arguments ? { args: request.params.arguments } : {}),
          });

          return {
            description: result.description,
            messages: result.messages.flatMap(toWirePromptMessages),
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
 */
export function toWirePrompt(decl: PromptDeclaration): McpWirePrompt {
  const wire: McpWirePrompt = { name: decl.name, description: decl.description };
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
 * Multi-block messages produce one PromptMessage per supported block.
 */
export function toWirePromptMessages(entry: MessageEntry): readonly McpWirePromptMessage[] {
  const role = mapRole(entry.role);
  if (role === null) return [];
  const out: McpWirePromptMessage[] = [];
  for (const block of entry.content) {
    const content = blockToWireContent(block);
    if (content !== null) out.push({ role, content });
  }
  return out;
}

function mapRole(role: string): "user" | "assistant" | null {
  if (role === "user" || role === "assistant") return role;
  if (role === "system") return "user";
  return null;
}

function blockToWireContent(block: ContentBlock): McpWirePromptMessage["content"] | null {
  // Text blocks are by far the dominant case — handle them precisely.
  // Other block types (image/audio/json/code/...) are best-effort
  // serialized to text for now; the full media-block surface lands
  // alongside #123 (resources) when wire content blocks get audited.
  if (isTextBlock(block)) {
    return { type: "text", text: block.text };
  }
  // Pragmatic fallback: render block as a fenced code blob so clients
  // see something coherent instead of dropping content. This matches
  // v1's behaviour for unknown blocks in prompts.
  return { type: "text", text: JSON.stringify(block) };
}
