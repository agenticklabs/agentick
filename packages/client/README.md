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

## Browser Support

- Chrome 89+
- Firefox 90+
- Safari 15+
- Edge 89+

## Cleanup

```typescript
client.destroy();
```
