/**
 * Tools projection — per-connection `tools/list` + `tools/call`.
 *
 * The harness wires this onto each connection's SDK `Server` instance.
 * On every request:
 *
 *  1. Build the per-request `McpRequestContext` from the connection
 *     state + SDK `RequestHandlerExtra`.
 *  2. Run the security pipeline (`evaluateRequestPipeline`).
 *  3. Apply the per-connection filter + transforms over the canonical
 *     tool registry.
 *  4. For `tools/list`, return projected declarations.
 *  5. For `tools/call`, resolve the handler, run it, return the result.
 *
 * Tool transforms run against the **already authenticated** context
 * (post-authenticator stage), so they can branch on `ctx.user`,
 * `ctx.user.roles`, etc.
 */

import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
  Tool as McpWireTool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchema, type ToolDeclaration } from "@agentick/spec-next";
import {
  McpServerError,
  type ContentBlock,
  type McpRequestContext,
  type TaskHandle,
} from "@agentick/spec-next";
import { applyTransform, composeTransforms } from "@agentick/tool-next/transforms";
import type { ToolTransform } from "@agentick/tool-next/transforms";

import { toCreateTaskResult, type ServerTaskRegistry } from "./tasks.js";

/**
 * Per-connection projection rules — narrow slice of
 * {@link McpServerToolsOptions} (config.ts) the projection layer
 * actually consumes. Distinct from the registry + resolveHandler which
 * are passed separately.
 */
export interface ToolsProjectionRules {
  readonly filter?: (tool: ToolDeclaration, ctx: McpRequestContext) => boolean;
  readonly transforms?: readonly ToolTransform<McpRequestContext>[];
}

import { evaluateRequestPipeline } from "../security/pipeline.js";
import type { ResolvedSecurity } from "../security/stages.js";

/**
 * Discriminated return shape from a resolved tool handler:
 *
 *   - `inline` — the handler ran and produced `ContentBlock[]`.
 *     Projection wraps as a `CallToolResult`.
 *   - `task` — the handler submitted a Pattern B task and returned a
 *     `TaskHandle`. Projection registers it with the server task
 *     registry and returns a `CreateTaskResult` on the wire.
 *
 * Adopters using the `tools: CreatedTool[]` form get this shape
 * built for them automatically (the framework inspects the handler
 * return via `isTaskHandle`). Adopters dropping to the low-level
 * `{ registry, resolveHandler }` escape hatch return this shape
 * directly — Pattern B is available there too if the resolver opts
 * in.
 */
export type ToolHandlerInvokeResult =
  | { readonly kind: "inline"; readonly content: readonly ContentBlock[] }
  | { readonly kind: "task"; readonly handle: TaskHandle<readonly ContentBlock[]> };

/**
 * Handler-resolution callback. The tool-executor (or test harness)
 * provides this — the projection layer doesn't know about the
 * tool-executor registry. Given a `handlerRef`, return the concrete
 * async handler.
 *
 * Return `null` for unknown refs — the projection turns this into a
 * tool-not-found `CallToolResult` (NOT a protocol error).
 */
export type ToolHandlerResolver = (
  handlerRef: string,
) => ((input: unknown, ctx: McpRequestContext) => Promise<ToolHandlerInvokeResult>) | null;

export interface ToolsProjectionOptions {
  /** Canonical tool registry — the projection filters + transforms this per connection. */
  readonly registry: readonly ToolDeclaration[];
  /**
   * Resolves `handlerRef` → concrete async handler. Returns the
   * Pattern-B-aware {@link ToolHandlerInvokeResult} discriminated
   * union so the projection can route TaskHandle returns to the
   * server task registry (#171d.3).
   */
  readonly resolveHandler: ToolHandlerResolver;
  /**
   * Per-connection task registry. Required for Pattern B routing;
   * when omitted, TaskHandle returns from handlers surface as a
   * tool-execution error.
   */
  readonly tasks?: ServerTaskRegistry;
  /** Per-connection filter + transforms — narrow slice of `McpServerOptions.tools`. */
  readonly projection?: ToolsProjectionRules;
  /** Security pipeline resolved for this server. */
  readonly security: ResolvedSecurity;
  /** Connection-scoped context base (the projection clones + augments per-request). */
  readonly buildContext: () => McpRequestContext;
}

/**
 * Install the `tools/list` and `tools/call` request handlers on an
 * SDK Server. Called once per connection at accept time.
 */
export function installToolsHandlers(sdkServer: SdkServer, options: ToolsProjectionOptions): void {
  const transforms = options.projection?.transforms ?? [];
  const composed = composeTransforms<McpRequestContext>(...transforms);
  const filter = options.projection?.filter;

  // ─────────── tools/list ───────────
  sdkServer.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest): Promise<ListToolsResult> => {
      const baseCtx = options.buildContext();
      const { ctx } = await evaluateRequestPipeline(options.security, baseCtx, {
        type: "tool_list",
      });
      const projected = projectTools(options.registry, filter, composed, ctx);
      return { tools: projected.map(toWireTool) };
    },
  );

  // ─────────── tools/call ───────────
  sdkServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const baseCtx = options.buildContext();
      const op = { type: "tool_call" as const, name: request.params.name };
      const { ctx, toolInput } = await evaluateRequestPipeline(
        options.security,
        baseCtx,
        op,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      );

      // Re-project so per-connection filter/transforms decide
      // visibility for this specific call. A tool hidden from `list`
      // must not be callable via `call` either.
      const projected = projectTools(options.registry, filter, composed, ctx);
      const tool = projected.find((t) => t.name === request.params.name);
      if (!tool) {
        // Tool either doesn't exist or is filtered for this connection.
        // Return an `isError: true` result rather than a JSON-RPC
        // protocol error — v1's distinction (tool-execution errors vs
        // protocol violations). Adopters can branch on `isError` in
        // their client tool wrappers.
        return {
          content: [
            {
              type: "text",
              text: `Tool not found or not available: ${request.params.name}`,
            },
          ],
          isError: true,
        };
      }
      if (!tool.handlerRef) {
        return {
          content: [{ type: "text", text: `Tool has no handlerRef: ${tool.name}` }],
          isError: true,
        };
      }
      const handler = options.resolveHandler(tool.handlerRef);
      if (!handler) {
        return {
          content: [
            {
              type: "text",
              text: `Tool handler unresolved: ${tool.handlerRef}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await handler(toolInput ?? {}, ctx);
        if (result.kind === "task") {
          // Pattern B — handler returned a TaskHandle. Register with
          // the per-connection task registry so subsequent
          // `tasks/get` / `tasks/result` / `tasks/cancel` requests
          // can drive its lifecycle, then return a wire
          // `CreateTaskResult`. Per the MCP wire codec
          // (discriminateCallToolResponse on the client side), the
          // `task` field discriminates this response from a regular
          // inline `CallToolResult`.
          if (!options.tasks) {
            return {
              content: [
                {
                  type: "text",
                  text: `Tool '${tool.name}' returned a TaskHandle but the server is not configured with tasks projection.`,
                },
              ],
              isError: true,
            };
          }
          options.tasks.register(result.handle);
          // The CreateTaskResult shape is structurally compatible
          // with the SDK's CallToolResult union via the discriminator
          // field `task`; cast through `unknown` because the SDK's
          // CallToolResult type doesn't include the task variant
          // (the wire spec evolved in 2025-11-25 and the SDK's
          // typings cover both via separate aliases).
          return toCreateTaskResult(result.handle.info()) as unknown as CallToolResult;
        }
        return { content: result.content as CallToolResult["content"], isError: false };
      } catch (cause) {
        // Tool-execution error — surface as `isError: true` per the v1
        // convention. JSON-RPC protocol errors are for transport /
        // schema / auth failures only.
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          content: [{ type: "text", text: `Tool error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Apply filter + composed transforms to the canonical registry.
 * Returns the per-connection projected view.
 */
export function projectTools(
  registry: readonly ToolDeclaration[],
  filter: ToolsProjectionRules["filter"] | undefined,
  composed: ToolTransform<McpRequestContext>,
  ctx: McpRequestContext,
): readonly ToolDeclaration[] {
  const filtered = filter ? registry.filter((t) => filter(t, ctx)) : registry;
  return applyTransform(composed, filtered, ctx);
}

/**
 * Convert a v2 `ToolDeclaration` to the MCP wire `Tool` shape. Reads
 * `metadata.title` + `metadata.icons` per the convention (see
 * `@agentick/tool-next/transforms/describe.ts`).
 *
 * Annotations flow through unchanged — they're semantic flags that
 * influence agent behavior; mutating per-connection would be a safety
 * footgun. See ADR 40 §4.
 */
export function toWireTool(decl: ToolDeclaration): McpWireTool {
  const meta = decl.metadata ?? {};
  const wire: McpWireTool = {
    name: decl.name,
    description: decl.description,
    inputSchema: toJsonSchema(decl.inputSchema) as McpWireTool["inputSchema"],
  };
  if (decl.outputSchema) {
    wire.outputSchema = toJsonSchema(decl.outputSchema) as McpWireTool["outputSchema"];
  }
  if (typeof meta.title === "string") {
    wire.title = meta.title;
  }
  if (Array.isArray(meta.icons)) {
    wire.icons = meta.icons as McpWireTool["icons"];
  }
  // #171d.3 — translate framework `annotations.taskSupport` to the
  // MCP wire `execution.taskSupport` enum so clients know to wrap
  // the tool in `ctx.tasks.submit(...)` (Pattern B). Mapping mirrors
  // mcp-next's `mapMcpTaskSupport` on the inbound client side:
  //   "required"    → "required"   (every call returns CreateTaskResult)
  //   "supported"   → "optional"   (caller picks per call)
  //   "unsupported" → "forbidden"
  const localTaskSupport = decl.annotations?.taskSupport;
  if (
    localTaskSupport === "required" ||
    localTaskSupport === "supported" ||
    localTaskSupport === "unsupported"
  ) {
    const wireTaskSupport: "required" | "optional" | "forbidden" =
      localTaskSupport === "required"
        ? "required"
        : localTaskSupport === "supported"
          ? "optional"
          : "forbidden";
    (
      wire as McpWireTool & {
        execution?: { taskSupport: "required" | "optional" | "forbidden" };
      }
    ).execution = { taskSupport: wireTaskSupport };
  }
  return wire;
}

/**
 * Type guard for typed errors thrown by the projection. Used in tests
 * + adopter catch sites that need to distinguish projection failures
 * from arbitrary thrown values.
 */
export function isProjectionError(value: unknown): value is McpServerError {
  return value instanceof McpServerError;
}
