/**
 * OpenAI-Compatible Inference Plugin
 *
 * Serves /v1/chat/completions and /v1/models. Any OpenAI SDK client
 * can point at the gateway and get streaming completions.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { StreamEvent } from "@agentick/shared";
import { StopReason, isNotFoundError, isValidationError } from "@agentick/shared";
import type { GatewayPlugin, PluginContext } from "../types.js";
import { fromOpenAIMessages, type OpenAIMessage } from "./openai-message-transform.js";

export interface OpenAICompatPluginConfig {
  /** Plugin ID (default: "openai-compat") */
  id?: string;
  /** Route prefix (default: "/v1") */
  pathPrefix?: string;
  /** Map OpenAI model names → gateway app IDs.
   *  Unmatched names route to the gateway's defaultApp. */
  modelMapping?: Record<string, string>;
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
}

export function openaiCompatPlugin(config: OpenAICompatPluginConfig = {}): GatewayPlugin {
  const pluginId = config.id ?? "openai-compat";
  const prefix = config.pathPrefix ?? "/v1";

  let ctx: PluginContext;

  return {
    id: pluginId,

    async initialize(pluginCtx) {
      ctx = pluginCtx;
      ctx.registerRoute(prefix, async (req, res) => {
        try {
          await handleRoute(req, res);
        } catch (err) {
          if (isNotFoundError(err)) {
            sendError(res, 404, "not_found", err.message);
          } else if (isValidationError(err)) {
            sendError(res, 400, "invalid_request_error", err.message);
          } else {
            sendError(res, 500, "internal_error", err instanceof Error ? err.message : "Internal server error");
          }
        }
      });
    },

    async destroy() {
      ctx.unregisterRoute(prefix);
    },
  };

  async function handleRoute(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    // Strip the prefix to get the sub-path
    const subPath = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length) || "/";

    if (subPath === "/models" && req.method === "GET") {
      return handleModels(res);
    }
    if (subPath === "/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req, res);
    }

    sendError(res, 404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
  }

  async function handleModels(res: ServerResponse) {
    const result = (await ctx.invoke("apps", {})) as {
      apps: Array<{ id: string; name: string; description?: string }>;
    };

    const response = {
      object: "list",
      data: result.apps.map((app) => ({
        id: app.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "agentick",
      })),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }

  async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
    const body = await parseBody(req);
    if (!body) {
      return sendError(res, 400, "invalid_request_error", "Invalid JSON body");
    }

    const request = body as unknown as ChatCompletionRequest;
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      return sendError(res, 400, "invalid_request_error", "messages is required and must be a non-empty array");
    }

    // Resolve model → app (missing model defaults to "default" which the gateway maps to defaultApp)
    const modelName = request.model || "default";
    const appId = config.modelMapping?.[modelName] ?? modelName;

    // Session key: use header or generate
    const sessionId =
      (req.headers["x-session-id"] as string) ??
      `${appId}:openai-${Date.now().toString(36)}`;

    // Convert messages
    const messages = fromOpenAIMessages(request.messages);

    // Send to session — catch app resolution errors as 404
    let events: AsyncIterable<StreamEvent>;
    try {
      events = await ctx.sendToSession(sessionId, { messages });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unknown app") || isNotFoundError(err)) {
        return sendError(res, 404, "model_not_found", `Model "${modelName}" not found. ${msg}`);
      }
      throw err;
    }

    if (request.stream) {
      return handleStreamingResponse(res, events, request.model);
    }
    return handleNonStreamingResponse(res, events, request.model);
  }

  async function handleStreamingResponse(
    res: ServerResponse,
    events: AsyncIterable<StreamEvent>,
    model: string,
  ) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const completionId = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    let toolCallIndex = 0;
    const toolCallIndices = new Map<string, number>();

    for await (const event of events) {
      const chunks = streamEventToChunks(event, completionId, created, model, toolCallIndices, toolCallIndex);
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      // Track tool call index
      if (event.type === "tool_call_start") {
        toolCallIndices.set(event.callId, toolCallIndex);
        toolCallIndex++;
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  }

  async function handleNonStreamingResponse(
    res: ServerResponse,
    events: AsyncIterable<StreamEvent>,
    model: string,
  ) {
    let content = "";
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    let finishReason: string | null = null;
    let currentToolCall: { id: string; name: string; args: string } | null = null;

    for await (const event of events) {
      switch (event.type) {
        case "content_delta":
          content += event.delta;
          break;
        case "tool_call_start":
          currentToolCall = {
            id: event.callId,
            name: event.name,
            args: "",
          };
          break;
        case "tool_call_delta":
          if (currentToolCall) {
            currentToolCall.args += event.delta;
          }
          break;
        case "tool_call_end":
          if (currentToolCall) {
            toolCalls.push({
              id: currentToolCall.id,
              type: "function",
              function: {
                name: currentToolCall.name,
                arguments: currentToolCall.args,
              },
            });
            currentToolCall = null;
          }
          break;
        case "message_end":
          finishReason = mapStopReason(event.stopReason);
          break;
      }
    }

    const response = {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || null,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          },
          finish_reason: finishReason ?? "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }
}

// ============================================================================
// Stream Event → OpenAI Chunk Mapping
// ============================================================================

function streamEventToChunks(
  event: StreamEvent,
  id: string,
  created: number,
  model: string,
  toolCallIndices: Map<string, number>,
  nextIndex: number,
): object[] {
  const base = { id, object: "chat.completion.chunk", created, model };

  switch (event.type) {
    case "content_delta":
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: event.delta },
              finish_reason: null,
            },
          ],
        },
      ];

    case "tool_call_start":
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: nextIndex,
                    id: event.callId,
                    type: "function",
                    function: { name: event.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ];

    case "tool_call_delta":
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndices.get(event.callId) ?? 0,
                    function: { arguments: event.delta },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ];

    case "message_end":
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: mapStopReason(event.stopReason),
            },
          ],
        },
      ];

    default:
      return [];
  }
}

function mapStopReason(reason: StopReason): string {
  switch (reason) {
    case StopReason.TOOL_USE:
    case StopReason.FUNCTION_CALL:
      return "tool_calls";
    case StopReason.MAX_TOKENS:
      return "length";
    case StopReason.CONTENT_FILTER:
      return "content_filter";
    default:
      return "stop";
  }
}

// ============================================================================
// Utilities
// ============================================================================

function parseBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown> | null> {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body as Record<string, unknown>);
  }
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendError(res: ServerResponse, status: number, type: string, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, code: null } }));
}
