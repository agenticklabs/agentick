# @agentick/client

Client SDK for multiplexed session access to a Agentick server. One client per app, many sessions per client.

## Installation

```bash
pnpm add @agentick/client
# or
npm install @agentick/client
```

## Quick Start

```typescript
import { createClient } from "@agentick/client";

const client = createClient({ baseUrl: "https://api.example.com" });

// Subscribe to a session (hot)
const conv = client.subscribe("conv-123");

// Listen for all events from this session
conv.onEvent((event) => {
  if (event.type === "content_delta") {
    process.stdout.write(event.delta);
  }
});

// Send a message and await result
const handle = conv.send({
  message: { role: "user", content: [{ type: "text", text: "Hello!" }] },
});
const result = await handle.result;
console.log(result.response);
```

## API Reference

### `createClient(config)`

Creates a new AgentickClient instance.

```typescript
const client = createClient({
  baseUrl: "https://api.example.com",
  token: "bearer_token",
  headers: { "x-tenant": "acme" },
  paths: {
    events: "/events",
    send: "/send",
    subscribe: "/subscribe",
    abort: "/abort",
    close: "/close",
    toolResponse: "/tool-response",
    channel: "/channel",
  },
});
```

### `client.session(sessionId)`

Returns a **cold** session accessor. No side effects until `subscribe()` or `send()` is called.

```typescript
const conv = client.session("conv-123");
conv.subscribe(); // make hot
```

### `client.subscribe(sessionId)`

Returns a **hot** session accessor. Subscribes immediately (auto-connects if needed).

```typescript
const conv = client.subscribe("conv-123");
```

### `client.send(input)`

Ephemeral send. Creates a session, executes, then closes.

```typescript
const handle = client.send({
  message: { role: "user", content: [{ type: "text", text: "Quick question" }] },
  props: { mode: "fast" },
});

for await (const event of handle) {
  if (event.type === "content_delta") {
    process.stdout.write(event.delta);
  }
}

const result = await handle.result;
```

## Session Accessor

### `accessor.subscribe()` / `accessor.unsubscribe()`

Turns a cold accessor hot, or turns it cold again. Subscriptions are scoped to the session.

### `accessor.send(input)`

Send to a session and return a `ClientExecutionHandle`.

### `accessor.onEvent(handler)`

Receives events for this session only.

### `accessor.onResult(handler)`

Receives final results for this session only (same as listening for `type: "result"`).

### `accessor.onToolConfirmation(handler)`

Receives tool confirmation requests for this session.

### `accessor.abort(reason?)` / `accessor.close()`

Abort the current execution or close the session server-side.

### `accessor.invoke(method, params?)`

Invoke a custom gateway method with auto-injected sessionId.

```typescript
const session = client.subscribe("conv-123");

// Invoke custom methods defined in gateway
const tasks = await session.invoke("tasks:list");
const newTask = await session.invoke("tasks:create", {
  title: "Buy groceries",
  priority: "high",
});

// Nested namespaces
await session.invoke("tasks:admin:archive");
```

### `accessor.stream(method, params?)`

Invoke a streaming method with auto-injected sessionId. Returns an async generator.

```typescript
const session = client.subscribe("conv-123");

// Stream updates from a custom method
for await (const change of session.stream("tasks:watch")) {
  console.log("Task changed:", change);
}
```

### `accessor.channel(name)`

Session-scoped channel for app-defined pub/sub.

```typescript
const conv = client.subscribe("conv-123");
const todos = conv.channel("todos");

todos.subscribe((payload) => {
  console.log("Todo update:", payload);
});

await todos.publish("add", { title: "Buy milk" });
```

## Global Events

### `client.onEvent(handler)`

Receives events from **all subscribed sessions**. Events include `sessionId` for routing.

```typescript
client.onEvent((event) => {
  console.log(event.sessionId, event.type);
});
```

### `client.on(type, handler)`

Convenience subscription by event type (e.g., `"content_delta"`, `"tool_call"`).

## Streaming Text

```typescript
client.onStreamingText((state) => {
  console.log(state.text, state.isStreaming);
});
```

## Tool Confirmation UI

```typescript
const session = client.subscribe("conv-123");

session.onToolConfirmation((request, respond) => {
  const approved = window.confirm(`Allow ${request.name}?`);
  respond({
    approved,
    reason: approved ? undefined : "User denied",
  });
});
```

## Error Handling

```typescript
client.onConnectionChange((state) => {
  if (state === "error") {
    console.error("Connection error");
  }
});
```

## Chat Primitives

Composable building blocks for chat UIs. Use `ChatSession` for the common case, or compose individual primitives for custom architectures.

### ChatSession

Complete chat controller — messages, steering, tool confirmations, and attachments in one snapshot.

```typescript
import { ChatSession } from "@agentick/client";

const chat = new ChatSession(client, {
  sessionId: "conv-123",
  autoSubscribe: true, // Subscribe to SSE transport (default: true)
  initialMessages: [], // Pre-loaded history
  transform: undefined, // Custom MessageTransform (default: timelineToMessages)
  renderMode: undefined, // Progressive rendering: "streaming" | "block" | "message"
  confirmationPolicy: undefined, // Auto-approve/deny policy (default: prompt all)
  deriveMode: undefined, // Custom ChatModeDeriver (default: idle/streaming/confirming_tool)
  onEvent: undefined, // Raw event hook
  attachments: undefined, // AttachmentManagerOptions (validator, toBlock, maxAttachments)
  // Inherits all MessageSteering options: mode, flushMode, autoFlush
});

// State (read-only snapshot, updated on every mutation)
chat.messages; // ChatMessage[]
chat.chatMode; // "idle" | "streaming" | "confirming_tool"
chat.toolConfirmation; // { request, respond } | null
chat.lastSubmitted; // Optimistic user message text
chat.queued; // Queued messages (queue mode)
chat.isExecuting; // Whether an execution is in progress
chat.mode; // "steer" | "queue"
chat.state.attachments; // Attachment[] (read-only snapshot)

// Attachments — add files before submit()
chat.attachments.add({ name: "photo.png", mimeType: "image/png", source: base64Data });
chat.attachments.remove(id);
chat.attachments.clear();
chat.attachments.count; // number
chat.attachments.isEmpty; // boolean

// Actions — submit(), steer(), and interrupt() drain pending attachments
chat.submit("Describe this image"); // Sends [ImageBlock, TextBlock]
chat.steer("Force send"); // Always send immediately (drains attachments)
chat.queue("Later"); // Always queue (no attachments)
chat.interrupt("Stop"); // Abort + send (drains attachments)
chat.flush(); // Flush next queued message
chat.respondToConfirmation({ approved: true });
chat.clearMessages();

// Subscribe
const unsub = chat.onStateChange(() => {
  console.log(chat.state);
});

chat.destroy();
```

#### Render Modes

Control how progressively messages appear in the message list. Without `renderMode`, messages only appear at `execution_end` (the entire execution must finish). With a render mode, content appears earlier:

| Mode          | Granularity    | Updates on                                            |
| ------------- | -------------- | ----------------------------------------------------- |
| `"streaming"` | Token-by-token | `content_delta`, `reasoning_delta`, `tool_call_delta` |
| `"block"`     | Full blocks    | `content`, `reasoning`, `tool_call`                   |
| `"message"`   | Full message   | `message`                                             |
| _(none)_      | Execution end  | `execution_end`                                       |

Each tier is a superset of the one above — `"streaming"` handles everything `"block"` does, plus finer deltas.

```typescript
// Block-at-a-time (recommended for terminal UIs)
const chat = new ChatSession(client, {
  sessionId: "conv-123",
  renderMode: "block",
});

// Token-by-token (recommended for web UIs)
const chat = new ChatSession(client, {
  sessionId: "conv-123",
  renderMode: "streaming",
});
```

When `renderMode` is set, user messages appear immediately on `submit()` (before the server responds). Reasoning blocks are included in progressive rendering for all modes.

#### Custom Chat Modes

The `deriveMode` option lets you define custom chat mode enums:

```typescript
type MyMode = "idle" | "working" | "needs_approval" | "error";

const chat = new ChatSession<MyMode>(client, {
  sessionId: "conv-123",
  deriveMode: ({ isExecuting, hasPendingConfirmation }) => {
    if (hasPendingConfirmation) return "needs_approval";
    if (isExecuting) return "working";
    return "idle";
  },
});

chat.chatMode; // MyMode — fully type-safe
```

#### Confirmation Policy

Auto-approve safe tools, prompt for dangerous ones:

```typescript
const chat = new ChatSession(client, {
  sessionId: "conv-123",
  confirmationPolicy: (request) => {
    if (["read_file", "glob", "grep"].includes(request.name)) {
      return { action: "approve" };
    }
    if (request.name === "rm") {
      return { action: "deny", reason: "Destructive operation" };
    }
    return { action: "prompt" };
  },
});
```

#### Attachments

Send images, PDFs, and other files alongside text. Platforms add files to the attachment manager, and `submit()` drains them into the user message automatically.

```typescript
// Add attachments before submitting
chat.attachments.add({
  name: "screenshot.png",
  mimeType: "image/png",
  source: base64String, // or URL string, or { type: "base64", data } / { type: "url", url }
  size: 102400, // optional
});

chat.submit("What's in this image?");
// Sends: [ImageBlock(screenshot.png), TextBlock("What's in this image?")]
// Attachments are cleared atomically on submit
```

The default validator accepts `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and `application/pdf`. Customize via options:

```typescript
import { defaultAttachmentValidator } from "@agentick/client";

const chat = new ChatSession(client, {
  sessionId: "conv-123",
  attachments: {
    maxAttachments: 5,
    validator: (input) => {
      // Compose with the default, or replace entirely
      if (input.size && input.size > 10_000_000) {
        return { valid: false, reason: "File too large (max 10MB)" };
      }
      return defaultAttachmentValidator(input);
    },
    toBlock: undefined, // Custom Attachment → ContentBlock mapper
  },
});
```

Source strings are auto-detected: `https://`, `http://`, `data:`, and `blob:` prefixes produce URL sources; everything else is treated as base64 data.

### Individual Primitives

For custom architectures, use the primitives directly. Each supports standalone mode (self-subscribes) or composed mode (`subscribe: false` + manual `processEvent()`).

#### MessageLog

Accumulates messages from execution lifecycle events with tool duration tracking.

```typescript
import { MessageLog } from "@agentick/client";

const log = new MessageLog(client, {
  sessionId: "conv-123",
  initialMessages: [],
  transform: undefined, // Custom MessageTransform
  renderMode: "block", // Progressive rendering (see below)
});

log.messages; // ChatMessage[]
log.pushUserMessage("Hello"); // Immediate (progressive modes)
log.clear();
log.destroy();
```

#### ToolConfirmations

Manages tool confirmation lifecycle with policy-based auto-resolution.

```typescript
import { ToolConfirmations } from "@agentick/client";

const tc = new ToolConfirmations(client, {
  sessionId: "conv-123",
  policy: (req) => (req.name === "read_file" ? { action: "approve" } : { action: "prompt" }),
});

tc.pending; // { request, respond } | null
tc.respond({ approved: true });
tc.destroy();
```

#### MessageSteering

Input-side message routing with queue/steer modes and auto-flush.

```typescript
import { MessageSteering } from "@agentick/client";

const steering = new MessageSteering(client, {
  sessionId: "conv-123",
  mode: "queue", // "queue" | "steer"
  flushMode: "sequential", // "sequential" | "batched"
  autoFlush: true,
});

steering.submit("Hello"); // Queue or send based on mode + execution state
steering.steer("Now"); // Always send
steering.queue("Later"); // Always queue
steering.flush();
steering.destroy();
```

#### Composition Pattern

All primitives support `subscribe: false` for parent-controlled event fan-out:

```typescript
const log = new MessageLog(client, { sessionId: "s1", subscribe: false });
const tc = new ToolConfirmations(client, { sessionId: "s1", subscribe: false });
const steering = new MessageSteering(client, { sessionId: "s1", subscribe: false });

// Single subscription, deterministic fan-out
const accessor = client.session("s1");
accessor.onEvent((event) => {
  steering.processEvent(event);
  log.processEvent(event);
});
accessor.onToolConfirmation((request, respond) => {
  tc.handleConfirmation(request, respond);
});
```

This is exactly what `ChatSession` does internally.

### Transforms

```typescript
import { timelineToMessages, extractToolCalls, defaultDeriveMode } from "@agentick/client";

// Convert timeline entries to chat messages with tool durations
const messages = timelineToMessages(entries, toolDurations);

// Extract tool calls from content blocks
const toolCalls = extractToolCalls(contentBlocks);

// Default chatMode derivation
const mode = defaultDeriveMode({ isExecuting: true, hasPendingConfirmation: false });
// → "streaming"
```

## Browser Support

- Chrome 89+
- Firefox 90+
- Safari 15+
- Edge 89+

## Cleanup

```typescript
client.destroy();
```
