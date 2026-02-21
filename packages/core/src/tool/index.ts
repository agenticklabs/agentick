/**
 * # Agentick Tools
 *
 * Tool definition and execution for Agentick agents. Tools are the bridge between
 * LLM reasoning and real-world actions.
 *
 * ## Features
 *
 * - **Type-Safe Definition** - Zod schema validation for inputs/outputs
 * - **Execution Modes** - SERVER, CLIENT, PROVIDER, MCP routing
 * - **JSX Integration** - Tools as components that register on mount
 * - **Hook System** - Middleware for validation, logging, metrics
 * - **Confirmation Flow** - User approval for sensitive operations
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createTool, ToolExecutionType } from 'agentick';
 * import { z } from 'zod';
 *
 * // Server-side tool
 * const searchTool = createTool({
 *   name: 'search',
 *   description: 'Search the database',
 *   input: z.object({
 *     query: z.string(),
 *     limit: z.number().optional().default(10),
 *   }),
 *   handler: async ({ query, limit }) => {
 *     return await db.search(query, limit);
 *   },
 * });
 *
 * // Client-side tool (runs in browser)
 * const confirmTool = createTool({
 *   name: 'confirm',
 *   description: 'Ask user for confirmation',
 *   type: ToolExecutionType.CLIENT,
 *   input: z.object({ message: z.string() }),
 *   // Handler runs on client, result sent back to server
 * });
 * ```
 *
 * ## Execution Types
 *
 * | Type | Description |
 * |------|-------------|
 * | `SERVER` | Executes on the server (default) |
 * | `CLIENT` | Executes in the browser, result sent back |
 * | `PROVIDER` | Handled by the model provider (e.g., web search) |
 * | `MCP` | Routed to Model Context Protocol server |
 *
 * @see {@link createTool} - Create type-safe tools
 * @see {@link ToolDefinition} - Tool definition interface
 * @see {@link ToolExecutionType} - Execution type enum
 *
 * @module agentick/tool
 */

export * from "./tool.js";
export * from "./tool-hooks.js";
export { useToolProcedure } from "./tool-procedure.js";
// Note: createComponentTool has been removed in Mark II.
// Use Harness component for sub-agent execution instead.
