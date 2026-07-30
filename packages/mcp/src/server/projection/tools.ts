/**
 * Tools projection — per-connection `tools/list` + `tools/call`.
 *
 * The harness wires this onto each connection's SDK `Server` instance.
 * Each handler declares a CROSSING (ADR 92 §Slice A) and hands its body to
 * `runCrossing`, which owns admission, the `mcp:command:<verb>` operation
 * envelope, the security stages on the op's guard seam, and the per-request
 * ctx mint. This module keeps only the projection work:
 *
 *  1. Apply the per-connection filter + transforms over the canonical
 *     tool registry.
 *  2. For `tools/list`, return projected declarations.
 *  3. For `tools/call`, resolve the handler, run it, return the result.
 *
 * Tool transforms run against the **already authenticated** context
 * (the crossing ctx, post-admission), so they can branch on `ctx.identity`,
 * `ctx.mcp.user.roles`, etc.
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
import { toJsonSchema, type ToolDeclaration, type Unsubscribe } from "@agentick/spec";
import type { ToolCatalog } from "@agentick/tool";
import {
  McpServerError,
  type ContentBlock,
  type McpRequestContext,
  type TaskHandle,
} from "@agentick/spec";
import { paginate } from "@agentick/utils";
import { applyTransform, composeTransforms } from "@agentick/tool/transforms";
import type { ToolTransform } from "@agentick/tool/transforms";

import { toCreateTaskResult, type ServerTaskRegistry } from "./tasks.js";
import { toWireContent } from "../../protocol/content.js";
import { readMcpToolExtensions, readMetadataIcons, readMetadataTitle } from "../wire-extensions.js";

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

import type { McpHandlerExtra, RunCrossing } from "./crossing.js";

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
  | {
      readonly kind: "inline";
      readonly content: readonly ContentBlock[];
      /**
       * ADR 70 — the `outputSchema`-validated typed machine result. Maps
       * to `CallToolResult.structuredContent` on the wire. Absent when
       * the handler returned no envelope `structuredContent`.
       */
      readonly structuredContent?: unknown;
      /**
       * ADR 70 — SOFT/domain error flag from the handler's result
       * envelope. Maps to `CallToolResult.isError`. Absent → `false`
       * (successful call); a thrown handler still routes through the
       * `catch` below to `isError: true`.
       */
      readonly isError?: boolean;
      /**
       * MCP result-side `_meta` (3b-0b-B). Free-form metadata projected
       * verbatim onto the wire `CallToolResult._meta`. The CreatedTool
       * wrapper reads it from the result envelope's `metadata.mcp.meta`
       * carriage ({@link McpToolResultExtensions}); low-level
       * `resolveHandler` adopters may set it directly. The canonical
       * producer is {@link wwwAuthenticateMeta} (mid-session step-up
       * auth). Absent → the wire result omits `_meta` (byte-identical to
       * before).
       */
      readonly _meta?: Readonly<Record<string, unknown>>;
    }
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
  /**
   * Tool-declaration source — the projection calls `.list()` on every
   * `tools/list` (and `tools/call` re-project) request, and subscribes
   * via `.subscribeAll(cb)` to fan mutations out as
   * `notifications/tools/list_changed`. Static-array adopters wrap
   * via `staticToolCatalog` upstream; dynamic adopters bring their
   * own catalog via `createToolCatalog` from `@agentick/tool`.
   */
  readonly registry: ToolCatalog;
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
  /**
   * The crossing-operation runner for this connection (ADR 92 §Slice A). Owns
   * admission, the `mcp:command:<verb>` envelope, the security stages on the
   * guard seam, and the per-request ctx mint.
   */
  readonly runCrossing: RunCrossing;
}

/**
 * Install the `tools/list` and `tools/call` request handlers on an
 * SDK Server. Called once per connection at accept time.
 *
 * Returns an `Unsubscribe` — call it from the connection close path
 * to stop the change-notification fan-out for this connection.
 * (Static-array registries wrap as a `staticToolCatalog` whose
 * `subscribeAll` is a no-op; the returned function still teardown-cleanly.)
 */
export function installToolsHandlers(
  sdkServer: SdkServer,
  options: ToolsProjectionOptions,
): Unsubscribe {
  const transforms = options.projection?.transforms ?? [];
  const composed = composeTransforms<McpRequestContext>(...transforms);
  const filter = options.projection?.filter;

  // ─────────── tools/list ───────────
  sdkServer.setRequestHandler(
    ListToolsRequestSchema,
    async (request: ListToolsRequest, extra: McpHandlerExtra): Promise<ListToolsResult> =>
      options.runCrossing({
        verb: "list-tools",
        operation: { type: "tool_list" },
        signal: extra.signal,
        run: async (_input, ctx): Promise<ListToolsResult> => {
          // Paginate AFTER the per-connection filter + transforms: pages must be
          // cut from what THIS connection can see, or a filtered-out tool would
          // leave a hole in someone's page. Catalogs at or under the page size
          // are byte-identical to the unpaginated reply (no `nextCursor` key).
          const projected = projectTools(options.registry.list(), filter, composed, ctx);
          const { page, nextCursor } = paginate(projected, request.params?.cursor);
          const result: ListToolsResult = { tools: page.map(toWireTool) };
          if (nextCursor !== undefined) result.nextCursor = nextCursor;
          return result;
        },
      }),
  );

  // ─────────── tools/call ───────────
  sdkServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest, extra: McpHandlerExtra): Promise<CallToolResult> => {
      // ADR 64 / A1 — the client's per-call `_meta.progressToken` rides into the
      // ctx mint so a handler calling `ctx.progress(ctx.mcp!.progressToken!, …)`
      // emits a signal the progress projection echoes back under the token the
      // client generated. Only `tools/call` carries one in the MCP spec.
      const progressToken = request.params._meta?.progressToken;
      return options.runCrossing({
        verb: "call-tool",
        operation: { type: "tool_call", name: request.params.name },
        params: { name: request.params.name },
        // #254 — the caller's cancellation reaches the handler as `ctx.signal`.
        signal: extra.signal,
        // The sanitizer stage (and any `onBeforeCallTool` hook) rewrites this;
        // the body below reads the POST-CASCADE value off `input`.
        toolInput: (request.params.arguments ?? {}) as Record<string, unknown>,
        ...(progressToken !== undefined ? { progressToken } : {}),
        run: async (input, ctx): Promise<CallToolResult> => {
          const toolInput = input.toolInput;

          // Re-project so per-connection filter/transforms decide
          // visibility for this specific call. A tool hidden from `list`
          // must not be callable via `call` either.
          const projected = projectTools(options.registry.list(), filter, composed, ctx);
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
            // ADR 70 — thread the handler's structuredContent + soft isError
            // onto the wire result. `structuredContent` only when present;
            // `isError` defaults to false for a resolved (non-throwing) call.
            // 3b-0b-B — result-side `_meta` (step-up auth etc.) rides onto
            // `CallToolResult._meta` only when the handler produced one, so a
            // handler that carried none is byte-identical to before.
            return {
              // #255 — the 23-member agentick union narrowed onto MCP's five,
              // once, in `protocol/content.ts`. Native kinds byte-stable;
              // everything else fenced text naming what was projected.
              content: toWireContent(result.content),
              isError: result.isError ?? false,
              ...(result.structuredContent !== undefined
                ? {
                    structuredContent:
                      result.structuredContent as CallToolResult["structuredContent"],
                  }
                : {}),
              ...(result._meta !== undefined ? { _meta: result._meta } : {}),
            };
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
      });
    },
  );

  // ─────────── notifications/tools/list_changed ───────────
  // The SDK only sends the notification when the connection has fully
  // initialized and the client advertised `tools.listChanged` support.
  // The SDK does the gating; we just call sendToolListChanged on
  // every catalog change. Static-array registries wrap as
  // `staticToolCatalog`, whose `subscribeAll` is a no-op — the
  // returned unsubscribe is safe to call regardless.
  const unsubscribe = options.registry.subscribeAll(() => {
    void sdkServer.sendToolListChanged().catch(() => {
      // Connection probably closed mid-notification — silently drop.
      // The catalog change still happened; future connections see the
      // new list state via `tools/list`.
    });
  });
  return unsubscribe;
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
 * `@agentick/tool/transforms/describe.ts`), plus the MCP-specific
 * `metadata.mcp` block (3b-0b-B — {@link McpToolDeclarationExtensions}):
 *   - `mcp.meta`        → wire `Tool._meta` (MCP Apps `ui://` linkage, …)
 *   - `mcp.annotations` → wire `Tool.annotations` advisory hints
 * Absent block ⇒ neither field is emitted (byte-identical to before).
 *
 * The wire `title` resolves `metadata.title ?? annotations.title`:
 * `metadata.title` is the per-connection OVERRIDE a `setTitle` transform
 * writes, and `annotations.title` is where `createTool({ title })` lands.
 * The MCP `annotations` block on the wire still carries hints ONLY — the
 * title is a top-level field, one source of truth for the value.
 *
 * The framework `annotations.taskSupport` still flows through to the
 * wire `execution` block below — it's a semantic flag that influences
 * agent behavior; mutating per-connection would be a safety footgun.
 * See ADR 40 §4.
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
  // `metadata.title` is the OVERRIDE (a per-connection `setTitle` transform
  // writes there); `annotations.title` is what `createTool({ title })` sets.
  // Reading only the former made an authored title vanish from the wire —
  // the tool showed up under its snake_case name with no way to tell why.
  const title = readMetadataTitle(meta) ?? decl.annotations?.title;
  if (title !== undefined) {
    wire.title = title;
  }
  const icons = readMetadataIcons(meta);
  if (icons !== undefined) {
    wire.icons = icons as McpWireTool["icons"];
  }
  // 3b-0b-B — MCP declaration extensions carried under `metadata.mcp`.
  const mcpExt = readMcpToolExtensions(meta);
  if (mcpExt?.meta !== undefined) {
    wire._meta = mcpExt.meta as McpWireTool["_meta"];
  }
  if (mcpExt?.annotations !== undefined) {
    const hints = mcpExt.annotations;
    const annotations: NonNullable<McpWireTool["annotations"]> = {};
    if (hints.readOnlyHint !== undefined) annotations.readOnlyHint = hints.readOnlyHint;
    if (hints.destructiveHint !== undefined) annotations.destructiveHint = hints.destructiveHint;
    if (hints.idempotentHint !== undefined) annotations.idempotentHint = hints.idempotentHint;
    if (hints.openWorldHint !== undefined) annotations.openWorldHint = hints.openWorldHint;
    // Only attach when at least one hint was set, so an empty
    // `annotations: {}` never appears on the wire.
    if (Object.keys(annotations).length > 0) {
      wire.annotations = annotations;
    }
  }
  // #171d.3 — translate framework `annotations.taskSupport` to the
  // MCP wire `execution.taskSupport` enum so clients know to wrap
  // the tool in `ctx.tasks.submit(...)` (Pattern B). Mapping mirrors
  // @agentick/mcp's `mapMcpTaskSupport` on the inbound client side:
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
