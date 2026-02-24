# Gateway Protocol

The gateway exposes a JSON-RPC-like protocol over WebSocket and HTTP/SSE.
The `schema` method returns the complete protocol contract — any client in any
language can discover all methods, events, and error codes at runtime.

## Connection

**WebSocket:** Connect to `ws://host:port`. Send a `connect` message:

```json
{ "type": "connect", "clientId": "my-client" }
```

The gateway replies with `connected`:

```json
{
  "type": "connected",
  "gatewayId": "gw-abc",
  "protocolVersion": "1.0",
  "apps": ["coding", "research"],
  "sessions": []
}
```

**HTTP/SSE:** `GET /events?clientId=my-client` for the event stream.
RPC calls go to `POST /invoke` with `{ method, params }`.

## RPC Envelope

Every request follows the same shape:

```json
{ "type": "req", "id": "req-1", "method": "schema", "params": {} }
```

Success responses:

```json
{ "type": "res", "id": "req-1", "ok": true, "payload": { ... } }
```

Error responses include a structured error code:

```json
{
  "type": "res",
  "id": "req-1",
  "ok": false,
  "error": { "code": "NOT_FOUND_RESOURCE", "message": "..." }
}
```

## Schema Discovery

Call the `schema` method with no params to discover the full protocol at
runtime. The response is the complete contract — every method with full JSON
Schema for params and response, every event type with its category, and every
error code with its description.

### Response Shape

```typescript
{
  protocolVersion: "1.0",

  // Every method (built-in and custom) with full JSON Schema
  methods: {
    "send": {
      description: "Send message to session",
      builtin: true,
      params: { /* JSON Schema */ },
      response: { /* JSON Schema */ },
      errors: ["NOT_FOUND_RESOURCE", "VALIDATION_REQUIRED"]
    },
    "my-plugin:analyze": {
      description: "Analyze text",
      builtin: false,
      params: { /* JSON Schema */ },
      response: { /* JSON Schema */ },
      roles: ["analyst"]
    },
    ...
  },

  // Every event type with its category
  events: [
    { type: "content_delta",   category: "model" },
    { type: "execution_start", category: "orchestration" },
    { type: "result",          category: "result" },
    { type: "channel",         category: "gateway" },
    ...
  ],

  // All possible error codes with descriptions
  errors: {
    "NOT_FOUND_RESOURCE":     "Resource not found (session, method, tool)",
    "NOT_FOUND_TOOL":         "Tool not found",
    "GUARD_DENIED":           "Access denied by guard (role, permission)",
    "VALIDATION_REQUIRED":    "Required parameter missing",
    "VALIDATION_TYPE":        "Parameter type mismatch",
    "STATE_ALREADY_COMPLETE": "Operation on closed/completed resource",
    "METHOD_ERROR":           "Unhandled error in method handler",
    "INTERNAL_ERROR":         "Unexpected internal error"
  }
}
```

### Method Entries

Every method in the `methods` record has these fields:

| Field         | Type          | Description                                                       |
| ------------- | ------------- | ----------------------------------------------------------------- |
| `description` | `string`      | Human-readable purpose                                            |
| `builtin`     | `boolean`     | `true` for gateway-provided, `false` for custom/plugin            |
| `params`      | `JSONSchema?` | Input parameters schema. Absent if method takes no params.        |
| `response`    | `JSONSchema?` | Response payload schema. Absent if method returns void.           |
| `errors`      | `string[]?`   | Error codes this method can produce. References keys in `errors`. |
| `roles`       | `string[]?`   | Required user roles. Absent if unrestricted.                      |

Custom methods are registered via the `methods` config or plugin `registerMethod`.

## Events

Events are pushed to subscribed clients via the event stream. Each event has a
`type` (the discriminant you match on) and a `category`:

| Category        | Description                                        | Examples                                      |
| --------------- | -------------------------------------------------- | --------------------------------------------- |
| `model`         | Model output (streaming content, tool calls)       | `content_delta`, `tool_call_start`, `message` |
| `orchestration` | Engine lifecycle (ticks, executions, tool results) | `execution_start`, `tick_end`, `tool_result`  |
| `result`        | Final execution result                             | `result`                                      |
| `gateway`       | Gateway-specific (channels, streaming methods)     | `channel`, `method:chunk`, `method:end`       |

Categories enable efficient filtering. A streaming UI subscribes to `model`
events. A persistence layer subscribes to `orchestration`. A simple
request/response client only waits for `result`.

## Error Codes

Error codes on method entries reference keys in the top-level `errors` record.
A `send` call might return `NOT_FOUND_RESOURCE` (bad session ID) or
`VALIDATION_REQUIRED` (missing message). The catch-all `METHOD_ERROR` covers
unhandled exceptions.

Error codes come from the framework's error hierarchy (`@agentick/shared`):

| Code                     | When                                       |
| ------------------------ | ------------------------------------------ |
| `NOT_FOUND_RESOURCE`     | Session, method, or resource doesn't exist |
| `NOT_FOUND_TOOL`         | Tool name not found in session             |
| `VALIDATION_REQUIRED`    | Required parameter missing                 |
| `VALIDATION_TYPE`        | Parameter type mismatch                    |
| `GUARD_DENIED`           | Role or custom guard rejected the call     |
| `STATE_ALREADY_COMPLETE` | Operation on a closed/terminal resource    |
| `METHOD_ERROR`           | Unhandled error in a method handler        |
| `INTERNAL_ERROR`         | Unexpected internal error                  |

## Built-In Methods

| Method              | Params                                        | Response                | Description                  |
| ------------------- | --------------------------------------------- | ----------------------- | ---------------------------- |
| `send`              | `sessionId`, `message`, `attachments?`        | `{ messageId }`         | Send user message            |
| `abort`             | `sessionId`                                   | —                       | Abort current execution      |
| `status`            | `sessionId?`                                  | `{ gateway, session? }` | Get status                   |
| `history`           | `sessionId`, `limit?`, `before?`              | `{ messages, hasMore }` | Get history                  |
| `reset`             | `sessionId`                                   | `{ ok }`                | Reset session                |
| `close`             | `sessionId`                                   | `{ ok }`                | Close session                |
| `apps`              | —                                             | `{ apps }`              | List apps                    |
| `sessions`          | —                                             | `{ sessions }`          | List sessions                |
| `subscribe`         | `sessionId`                                   | `{ ok }`                | Subscribe to events          |
| `unsubscribe`       | `sessionId`                                   | `{ ok }`                | Unsubscribe                  |
| `channel`           | `sessionId`, `channel`, `payload?`            | `{ ok }`                | Publish to channel           |
| `channel-subscribe` | `sessionId`, `channel`                        | `{ ok }`                | Subscribe to channel         |
| `schema`            | —                                             | `SchemaPayload`         | Protocol discovery           |
| `tool-catalog`      | `sessionId`                                   | `{ tools }`             | List session tools           |
| `tool-confirm`      | `sessionId`, `callId`, `confirmed`, `reason?` | `{ ok }`                | Respond to tool confirmation |
| `tool-dispatch`     | `sessionId`, `tool`, `input`                  | `{ content }`           | Dispatch tool directly       |

## Custom Methods

Register via gateway config:

```typescript
import { createGateway, method } from "@agentick/gateway";

createGateway({
  apps: { myApp },
  defaultApp: "myApp",
  methods: {
    analyze: method({
      description: "Analyze text",
      schema: z.object({ text: z.string() }),
      response: z.object({ sentiment: z.number() }),
      roles: ["analyst"],
      handler: async (params) => ({ sentiment: 0.8 }),
    }),
  },
});
```

Or via plugin:

```typescript
ctx.registerMethod(
  "analyze",
  method({
    schema: z.object({ text: z.string() }),
    response: z.object({ sentiment: z.number() }),
    handler: async (params) => ({ sentiment: 0.8 }),
  }),
);
```

Both `schema` (params) and `response` accept Zod 3, Zod 4, or any Standard
Schema. They are converted to JSON Schema in the `schema` method response.
