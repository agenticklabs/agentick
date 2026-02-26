/**
 * Gateway Method Schemas
 *
 * JSON Schema definitions for every built-in method's params and response.
 * Error code catalog. Event type catalog (derived from shared arrays).
 *
 * A client in any language can build a full SDK from the schema response alone.
 */

import type { AgentickErrorCode } from "@agentick/shared";
import { MODEL_EVENT_TYPES, ORCHESTRATION_EVENT_TYPES, RESULT_EVENT_TYPES } from "@agentick/shared";

type JSONSchema = Record<string, unknown>;

// ============================================================================
// Shared Schema Fragments
// ============================================================================

const SessionIdParams: JSONSchema = {
  type: "object",
  properties: { sessionId: { type: "string" } },
  required: ["sessionId"],
};

const OkResponse: JSONSchema = {
  type: "object",
  properties: { ok: { type: "boolean", const: true } },
  required: ["ok"],
};

// ============================================================================
// Params Schemas
// ============================================================================

const SendParams: JSONSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    input: {
      type: "object",
      description: "Full SendInput with messages, props, metadata",
      properties: {
        messages: { type: "array", items: { type: "object" } },
        props: { type: "object", additionalProperties: true },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    message: { type: "string", description: "Convenience shorthand for text-only sends" },
  },
  required: ["sessionId"],
};

const StatusParams: JSONSchema = {
  type: "object",
  properties: { sessionId: { type: "string" } },
};

const HistoryParams: JSONSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    limit: { type: "number" },
    before: { type: "string" },
  },
  required: ["sessionId"],
};

const ChannelSubscribeParams: JSONSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    channel: { type: "string" },
  },
  required: ["sessionId", "channel"],
};

const ChannelParams: JSONSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    channel: { type: "string" },
    payload: {},
  },
  required: ["sessionId", "channel"],
};

const ToolCatalogParams: JSONSchema = {
  type: "object",
  properties: { sessionId: { type: "string" } },
  required: ["sessionId"],
};

const ToolConfirmParams: JSONSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    callId: { type: "string" },
    confirmed: { type: "boolean" },
    reason: { type: "string" },
    always: { type: "boolean" },
  },
  required: ["sessionId", "callId", "confirmed"],
};

const ToolDispatchParams: JSONSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    tool: { type: "string" },
    input: { type: "object", additionalProperties: true },
  },
  required: ["sessionId", "tool", "input"],
};

// ============================================================================
// Response Schemas
// ============================================================================

const SendResponse: JSONSchema = {
  type: "object",
  properties: { messageId: { type: "string" } },
  required: ["messageId"],
};

const StatusResponse: JSONSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        id: { type: "string" },
        uptime: { type: "number" },
        clients: { type: "number" },
        sessions: { type: "number" },
        apps: { type: "array", items: { type: "string" } },
      },
      required: ["id", "uptime", "clients", "sessions", "apps"],
    },
    session: {
      type: "object",
      properties: {
        id: { type: "string" },
        appId: { type: "string" },
        messageCount: { type: "number" },
        createdAt: { type: "string" },
        lastActivityAt: { type: "string" },
        isActive: { type: "boolean" },
      },
    },
  },
  required: ["gateway"],
};

const HistoryResponse: JSONSchema = {
  type: "object",
  properties: {
    messages: { type: "array", items: { type: "object" } },
    hasMore: { type: "boolean" },
  },
  required: ["messages", "hasMore"],
};

const AppsResponse: JSONSchema = {
  type: "object",
  properties: {
    apps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          isDefault: { type: "boolean" },
        },
        required: ["id", "name", "isDefault"],
      },
    },
  },
  required: ["apps"],
};

const SessionsResponse: JSONSchema = {
  type: "object",
  properties: {
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          appId: { type: "string" },
          createdAt: { type: "string" },
          lastActivityAt: { type: "string" },
          messageCount: { type: "number" },
        },
        required: ["id", "appId", "createdAt", "lastActivityAt", "messageCount"],
      },
    },
  },
  required: ["sessions"],
};

const ToolCatalogResponse: JSONSchema = {
  type: "object",
  properties: {
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          input: { type: "object" },
          type: { type: "string" },
          intent: { type: "string" },
          audience: { type: "string" },
        },
        required: ["name", "description", "input"],
      },
    },
  },
  required: ["tools"],
};

const ToolDispatchResponse: JSONSchema = {
  type: "object",
  properties: {
    content: { type: "array" },
  },
  required: ["content"],
};

// ============================================================================
// Method Registry
// ============================================================================

export interface MethodSchema {
  description: string;
  params?: JSONSchema;
  response?: JSONSchema;
  errors?: string[];
}

export const BUILT_IN_METHOD_SCHEMAS = new Map<string, MethodSchema>([
  [
    "send",
    {
      description: "Send message to session",
      params: SendParams,
      response: SendResponse,
      errors: ["NOT_FOUND_RESOURCE", "VALIDATION_REQUIRED"],
    },
  ],
  [
    "abort",
    {
      description: "Abort current execution",
      params: SessionIdParams,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "status",
    {
      description: "Get gateway/session status",
      params: StatusParams,
      response: StatusResponse,
    },
  ],
  [
    "history",
    {
      description: "Get conversation history",
      params: HistoryParams,
      response: HistoryResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "reset",
    {
      description: "Reset a session",
      params: SessionIdParams,
      response: OkResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "close",
    {
      description: "Close a session",
      params: SessionIdParams,
      response: OkResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  ["apps", { description: "List available apps", response: AppsResponse }],
  ["sessions", { description: "List sessions", response: SessionsResponse }],
  [
    "subscribe",
    {
      description: "Subscribe to session events",
      params: SessionIdParams,
      response: OkResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "unsubscribe",
    {
      description: "Unsubscribe from events",
      params: SessionIdParams,
      response: OkResponse,
    },
  ],
  [
    "channel",
    {
      description: "Publish to a channel",
      params: ChannelParams,
      response: OkResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "channel-subscribe",
    {
      description: "Subscribe to a channel",
      params: ChannelSubscribeParams,
      response: OkResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  ["schema", { description: "Get protocol schema" }],
  [
    "tool-catalog",
    {
      description: "Get tool definitions for session",
      params: ToolCatalogParams,
      response: ToolCatalogResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "tool-confirm",
    {
      description: "Respond to tool confirmation",
      params: ToolConfirmParams,
      response: OkResponse,
      errors: ["NOT_FOUND_RESOURCE"],
    },
  ],
  [
    "tool-dispatch",
    {
      description: "Dispatch tool by name",
      params: ToolDispatchParams,
      response: ToolDispatchResponse,
      errors: ["NOT_FOUND_RESOURCE", "NOT_FOUND_TOOL"],
    },
  ],
  [
    "config",
    {
      description: "Get resolved configuration (secret values redacted)",
      response: {
        type: "object",
        properties: {
          config: { type: "object", additionalProperties: true },
        },
        required: ["config"],
      },
    },
  ],
]);

// ============================================================================
// Error Codes
// ============================================================================

type GatewayErrorCode = "METHOD_ERROR" | "INTERNAL_ERROR";
export type ProtocolErrorCode = AgentickErrorCode | GatewayErrorCode;

export const PROTOCOL_ERROR_CODES: Record<string, string> = {
  // From shared error hierarchy
  NOT_FOUND_RESOURCE: "Resource not found (session, method, tool)",
  NOT_FOUND_TOOL: "Tool not found",
  VALIDATION_REQUIRED: "Required parameter missing",
  VALIDATION_TYPE: "Parameter type mismatch",
  GUARD_DENIED: "Access denied by guard (role, permission)",
  STATE_ALREADY_COMPLETE: "Operation on closed/completed resource",
  // Gateway-specific
  METHOD_ERROR: "Unhandled error in method handler",
  INTERNAL_ERROR: "Unexpected internal error",
};

// ============================================================================
// Event Catalog
// ============================================================================

export const GATEWAY_EVENT_TYPES = [
  "channel",
  "method:chunk",
  "method:end",
  "config:changed",
] as const;

type EventCategory = "model" | "orchestration" | "result" | "gateway";

export interface EventSchemaEntry {
  type: string;
  category: EventCategory;
}

function categorize(types: readonly string[], category: EventCategory): EventSchemaEntry[] {
  return types.map((type) => ({ type, category }));
}

export const GATEWAY_EVENTS: EventSchemaEntry[] = [
  ...categorize(MODEL_EVENT_TYPES, "model"),
  ...categorize(ORCHESTRATION_EVENT_TYPES, "orchestration"),
  ...categorize(RESULT_EVENT_TYPES, "result"),
  ...categorize(GATEWAY_EVENT_TYPES, "gateway"),
];
