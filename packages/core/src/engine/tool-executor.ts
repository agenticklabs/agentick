import {
  type ToolCall,
  type ToolResult,
  type ExecutableTool,
  type ToolConfirmationResult,
  ToolExecutionType,
} from "../tool/tool";
import { COM } from "../com/object-model";
import { type ContentBlock } from "@tentickle/shared";
import { type Middleware, type MiddlewarePipeline } from "../core/index";
import { type ToolHookMiddleware, type ToolHookName, ToolHookRegistry } from "../tool/tool-hooks";
import { applyRegistryMiddleware } from "../procedure";
import { ClientToolCoordinator } from "./client-tool-coordinator";
import { ToolConfirmationCoordinator } from "./tool-confirmation-coordinator";

/**
 * Result of checking if a tool requires confirmation.
 */
export interface ConfirmationCheckResult {
  /** Whether confirmation is required */
  required: boolean;
  /** Message to show user (if required) */
  message?: string;
  /** The tool that was checked */
  tool: ExecutableTool;
}

/**
 * Normalize tool hook middleware to the format required by applyRegistryMiddleware.
 * This is a type-cast helper since the middleware types are compatible at runtime.
 */
function normalizeToolHookMiddleware(
  middleware: ToolHookMiddleware<ToolHookName>[],
): (Middleware<any[]> | MiddlewarePipeline)[] {
  if (!middleware || middleware.length === 0) {
    return [];
  }
  return middleware as unknown as (Middleware<any[]> | MiddlewarePipeline)[];
}

/**
 * Tool Execution Service
 *
 * Handles tool execution with error handling, parallel execution support,
 * and structured error reporting. Designed to be extensible for future
 * features like retries, timeouts, circuit breakers, etc.
 */
export class ToolExecutor {
  private clientToolCoordinator: ClientToolCoordinator;
  private confirmationCoordinator: ToolConfirmationCoordinator;

  constructor(private toolHooks?: ToolHookRegistry) {
    this.clientToolCoordinator = new ClientToolCoordinator();
    this.confirmationCoordinator = new ToolConfirmationCoordinator();
  }

  /**
   * Get the client tool coordinator for managing client-executed tools.
   */
  getClientToolCoordinator(): ClientToolCoordinator {
    return this.clientToolCoordinator;
  }

  /**
   * Get the confirmation coordinator for managing tool confirmations.
   */
  getConfirmationCoordinator(): ToolConfirmationCoordinator {
    return this.confirmationCoordinator;
  }

  /**
   * Check if a tool call requires confirmation.
   * Evaluates the requiresConfirmation option (boolean or function).
   *
   * @param call - The tool call to check
   * @param com - COM for tool resolution
   * @param configTools - Optional config tools for fallback
   * @returns ConfirmationCheckResult or null if tool not found
   */
  async checkConfirmationRequired(
    call: ToolCall,
    com: COM,
    configTools: ExecutableTool[] = [],
  ): Promise<ConfirmationCheckResult | null> {
    // Resolve tool
    let tool: ExecutableTool | undefined = com.getTool(call.name);
    if (!tool && configTools.length > 0) {
      tool = configTools.find((t) => t.metadata.name === call.name);
    }
    if (!tool) {
      return null;
    }

    const { requiresConfirmation, confirmationMessage } = tool.metadata;

    // No confirmation configured
    if (requiresConfirmation === undefined || requiresConfirmation === false) {
      return { required: false, tool };
    }

    // Evaluate if it's a function
    let required: boolean;
    if (typeof requiresConfirmation === "function") {
      required = await requiresConfirmation(call.input);
    } else {
      required = requiresConfirmation;
    }

    if (!required) {
      return { required: false, tool };
    }

    // Build confirmation message
    let message: string;
    if (typeof confirmationMessage === "function") {
      message = confirmationMessage(call.input);
    } else if (confirmationMessage) {
      message = confirmationMessage;
    } else {
      message = `Allow ${call.name} to execute?`;
    }

    return { required: true, message, tool };
  }

  /**
   * Wait for confirmation for a tool call.
   * Should be called after yielding 'tool_confirmation_required' event.
   *
   * @param call - The tool call awaiting confirmation
   * @returns The confirmation result
   */
  async waitForConfirmation(call: ToolCall): Promise<ToolConfirmationResult> {
    return this.confirmationCoordinator.waitForConfirmation(call.id, call.name);
  }

  /**
   * Create a denial result for when user denies tool execution.
   */
  createDenialResult(call: ToolCall): ToolResult {
    return {
      toolUseId: call.id,
      name: call.name || call.id,
      success: false,
      content: [
        {
          type: "text" as const,
          text: "Tool execution was denied by user.",
        },
      ],
      error: "User denied tool execution",
    };
  }

  /**
   * Wrap tool.run with hooks if hooks are registered.
   * Since tool.run is already a Procedure, we apply middleware directly to it
   * using applyRegistryMiddleware, which preserves the Procedure interface.
   *
   * Returns undefined if tool has no handler (e.g., client tools without server-side execution).
   */
  private wrapToolRun(tool: ExecutableTool): ExecutableTool["run"] | undefined {
    if (!tool.run) {
      return undefined; // Tool has no handler
    }

    if (!this.toolHooks) {
      return tool.run;
    }

    const middleware = this.toolHooks.getMiddleware("run") as ToolHookMiddleware<ToolHookName>[];
    if (middleware.length === 0) {
      return tool.run;
    }

    // Apply tool hooks middleware to the existing Procedure
    // applyRegistryMiddleware preserves the Procedure interface while adding middleware
    return applyRegistryMiddleware(
      tool.run,
      ...normalizeToolHookMiddleware(middleware),
    ) as ExecutableTool["run"];
  }

  /**
   * Execute tool calls sequentially or in parallel.
   *
   * @param toolCalls Array of tool calls to execute
   * @param com COM for tool resolution
   * @param parallel Whether to execute tools in parallel (default: false)
   * @param configTools Optional array of tools from Engine config for fallback resolution
   * @returns Array of tool results
   */
  async executeToolCalls(
    toolCalls: ToolCall[],
    com: COM,
    parallel: boolean = false,
    configTools: ExecutableTool[] = [],
  ): Promise<ToolResult[]> {
    if (parallel && toolCalls.length > 1) {
      return this.executeParallel(toolCalls, com, configTools);
    }
    return this.executeSequential(toolCalls, com, configTools);
  }

  /**
   * Execute tools sequentially (current implementation).
   * Provides better error isolation and easier debugging.
   */
  private async executeSequential(
    toolCalls: ToolCall[],
    com: COM,
    configTools: ExecutableTool[] = [],
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      const result = await this.executeSingleTool(call, com, configTools);
      results.push(result);
    }

    return results;
  }

  /**
   * Execute tools in parallel (future implementation).
   * Will be enhanced with proper error handling, timeouts, etc.
   */
  private async executeParallel(
    toolCalls: ToolCall[],
    com: COM,
    configTools: ExecutableTool[] = [],
  ): Promise<ToolResult[]> {
    // TODO: Implement proper parallel execution with:
    // - Timeout handling
    // - Error isolation
    // - Result ordering preservation
    // - Circuit breaker patterns
    const promises = toolCalls.map((call) => this.executeSingleTool(call, com, configTools));
    return Promise.all(promises);
  }

  /**
   * Execute a single tool call with comprehensive error handling.
   * This method does NOT handle confirmation - caller should check confirmation first.
   *
   * @param call - The tool call to execute
   * @param com - COM for tool resolution
   * @param configTools - Optional config tools for fallback
   * @returns The tool result
   */
  async executeSingleTool(
    call: ToolCall,
    com: COM,
    configTools: ExecutableTool[] = [],
  ): Promise<ToolResult> {
    // 1. Resolve tool
    let tool: ExecutableTool | undefined = com.getTool(call.name);

    // 2. Fallback to config tools
    if (!tool && configTools.length > 0) {
      tool = configTools.find((t) => t.metadata.name === call.name);
    }

    if (!tool) {
      return this.createErrorResult(call, `Tool "${call.name}" is not available`, "TOOL_NOT_FOUND");
    }

    // 3. Check execution type and route accordingly
    const executionType = tool.metadata.type ?? ToolExecutionType.SERVER;

    // Provider tools should be handled in ModelAdapter, not here
    if (executionType === ToolExecutionType.PROVIDER) {
      return this.createErrorResult(
        call,
        `Provider-executed tool "${call.name}" should be handled by ModelAdapter`,
        "INVALID_EXECUTION_TYPE",
      );
    }

    // Client tools - delegate to client and wait for result if needed
    if (executionType === ToolExecutionType.CLIENT) {
      const requiresResponse = tool.metadata.requiresResponse ?? false;
      const timeout = tool.metadata.timeout ?? 30000;
      const defaultResult: ToolResult = {
        toolUseId: call.id,
        name: call.name || call.id,
        success: true,
        content: tool.metadata.defaultResult ?? [
          { type: "text", text: `[${call.name} rendered on client]` },
        ],
      };

      // If doesn't require response, return default immediately
      if (!requiresResponse) {
        return defaultResult;
      }

      // Otherwise wait for client to send result
      try {
        return await this.clientToolCoordinator.waitForResult(
          call.id,
          defaultResult,
          requiresResponse,
          timeout,
        );
      } catch (error: any) {
        return this.createErrorResult(
          call,
          error.message || "Client tool execution failed",
          "CLIENT_TOOL_ERROR",
          error,
        );
      }
    }

    // 4. Execute tool with error handling (SERVER or MCP)
    try {
      // Wrap tool.run with hooks if hooks are registered
      const wrappedRun = this.wrapToolRun(tool);

      if (!wrappedRun) {
        // Tool has no handler (e.g., client tool without server-side execution)
        // Return error - tools without handlers cannot be executed server-side
        return this.createErrorResult(
          call,
          `Tool "${call.name}" has no handler. Tools without handlers cannot be executed server-side.`,
          "TOOL_NO_HANDLER",
        );
      }

      // Execute tool (execution type doesn't change the call pattern,
      // but MCP/CLIENT tools have different run() implementations)
      // Add runtime metadata for DevTools/telemetry
      const toolProcedure = wrappedRun.withMetadata({
        toolName: call.name,
        toolId: call.id,
      });
      const result = await toolProcedure(call.input);

      // Handle async iterable result (shouldn't happen for tools, but be safe)
      let content: ContentBlock[];
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        // If it's an async iterable, collect all chunks
        const chunks: ContentBlock[] = [];
        for await (const chunk of result as AsyncIterable<ContentBlock>) {
          chunks.push(chunk);
        }
        content = chunks;
      } else {
        content = result as ContentBlock[];
      }

      // Validate return type
      if (!Array.isArray(content)) {
        return this.createErrorResult(
          call,
          "Tool must return ContentBlock[]",
          "INVALID_RETURN_TYPE",
        );
      }

      // Validate content blocks
      for (const block of content) {
        if (!block || typeof block !== "object" || !block.type) {
          return this.createErrorResult(
            call,
            "Tool returned invalid ContentBlock",
            "INVALID_CONTENT_BLOCK",
          );
        }
      }

      const toolResult: ToolResult = {
        toolUseId: call.id,
        name: call.name || call.id,
        success: true,
        content,
      };

      call.result = toolResult;

      return toolResult;
    } catch (error: any) {
      // Enhanced error handling
      const errorMessage = error?.message || "Tool execution failed";
      const errorType = this.classifyError(error);

      return this.createErrorResult(call, errorMessage, errorType, error);
    }
  }

  /**
   * Create an error result with structured error information.
   */
  private createErrorResult(
    call: ToolCall,
    message: string,
    errorType: string,
    originalError?: any,
  ): ToolResult {
    const errorContent: ContentBlock[] = [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: message,
          error_type: errorType,
          ...(originalError && {
            error_details: {
              name: originalError?.name,
              code: originalError?.code,
              stack: process.env["NODE_ENV"] === "development" ? originalError?.stack : undefined,
            },
          }),
        }),
      },
    ];

    const toolResult: ToolResult = {
      toolUseId: call.id,
      name: call.name || call.id,
      success: false,
      content: errorContent,
      error: message,
    };

    call.result = toolResult;

    return toolResult;
  }

  /**
   * Classify errors for better recovery handling.
   */
  private classifyError(error: any): string {
    if (!error) return "UNKNOWN_ERROR";

    // Network/timeout errors
    if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET" || error.code === "ENOTFOUND") {
      return "NETWORK_ERROR";
    }

    // Rate limiting
    if (error.status === 429 || error.code === "RATE_LIMIT_EXCEEDED") {
      return "RATE_LIMIT_ERROR";
    }

    // Authentication/authorization
    if (error.status === 401 || error.status === 403) {
      return "AUTH_ERROR";
    }

    // Validation errors
    if (error.name === "ZodError" || error.name === "ValidationError") {
      return "VALIDATION_ERROR";
    }

    // Timeout errors
    if (error.name === "TimeoutError" || error.message?.includes("timeout")) {
      return "TIMEOUT_ERROR";
    }

    // Generic application errors
    if (error.name === "Error") {
      return "APPLICATION_ERROR";
    }

    return "UNKNOWN_ERROR";
  }

  /**
   * Process a single tool call with confirmation flow.
   *
   * This method handles the full lifecycle of a tool call:
   * 1. Check if confirmation is required
   * 2. If yes, emit confirmation_required event and wait for response
   * 3. Execute tool (or create denial result if denied)
   * 4. Return result with any events that occurred
   *
   * This is designed for parallel execution - each tool can independently
   * wait for confirmation while other tools are being processed.
   *
   * @param call - The tool call to process
   * @param com - COM for tool resolution
   * @param configTools - Optional config tools for fallback
   * @param callbacks - Callbacks for emitting events during processing
   * @returns The tool result and metadata about the processing
   */
  async processToolWithConfirmation(
    call: ToolCall,
    com: COM,
    configTools: ExecutableTool[] = [],
    callbacks: {
      onConfirmationRequired?: (call: ToolCall, message: string) => void | Promise<void>;
      onConfirmationResult?: (
        confirmation: ToolConfirmationResult,
        call: ToolCall,
      ) => void | Promise<void>;
    } = {},
  ): Promise<{
    result: ToolResult;
    confirmCheck: ConfirmationCheckResult | null;
    confirmation: ToolConfirmationResult | null;
  }> {
    // Check if confirmation is required
    const confirmCheck = await this.checkConfirmationRequired(call, com, configTools);

    let result: ToolResult;
    let confirmation: ToolConfirmationResult | null = null;

    if (confirmCheck?.required) {
      // Notify that confirmation is required
      if (callbacks.onConfirmationRequired) {
        await callbacks.onConfirmationRequired(
          call,
          confirmCheck.message || `Allow ${call.name} to execute?`,
        );
      }

      // Wait for confirmation (this blocks until client responds)
      confirmation = await this.waitForConfirmation(call);

      // Notify of confirmation result
      if (callbacks.onConfirmationResult) {
        await callbacks.onConfirmationResult(confirmation, call);
      }

      if (!confirmation.confirmed) {
        // User denied - create denial result
        result = this.createDenialResult(call);
      } else {
        // User confirmed - execute the tool
        result = await this.executeSingleTool(call, com, configTools);
      }
    } else {
      // No confirmation needed - execute directly
      result = await this.executeSingleTool(call, com, configTools);
    }

    return { result, confirmCheck, confirmation };
  }
}
