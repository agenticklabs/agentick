# @tentickle/server

Server SDK for Tentickle applications. Provides the building blocks for running Tentickle agents on the server:

- **Session handling** - Create, manage, and lifecycle sessions
- **Channel routing** - Route messages between clients and sessions
- **SSE utilities** - Stream events to clients via Server-Sent Events
- **Framework-agnostic routes** - Use with Express, Fastify, Hono, or any framework

## Installation

```bash
npm install @tentickle/server @tentickle/core @tentickle/shared
```

## Quick Start

```typescript
import { createApp } from "@tentickle/core/app";
import {
  createSessionHandler,
  createChannelBridge,
  createSessionRoutes,
  InMemorySessionStore,
  setSSEHeaders,
  streamToSSE,
} from "@tentickle/server";

// 1. Create your Tentickle app
const app = createApp(MyAgent, { model });

// 2. Create session handler
const sessionHandler = createSessionHandler({
  app,
  store: new InMemorySessionStore(),
});

// 3. Create channel bridge (for real-time communication)
const channelBridge = createChannelBridge({
  sessionHandler,
  autoJoinRooms: (meta) => [
    `user:${meta.userId}`,
    `session:${meta.sessionId}`,
  ],
});

// 4. Create framework-agnostic routes
const routes = createSessionRoutes({
  sessionHandler,
  channelBridge,
});
```

## Usage with Express

```typescript
import express from "express";

const app = express();
app.use(express.json());

// Create session
app.post("/session", async (req, res) => {
  const result = await routes.createSession(req.body);
  res.json(result);
});

// Send message and get response
app.post("/session/:id/send", async (req, res) => {
  const result = await routes.send({
    sessionId: req.params.id,
    ...req.body,
  });
  res.json(result);
});

// Stream events via SSE
app.get("/session/:id/stream", async (req, res) => {
  setSSEHeaders(res);

  const stream = routes.stream({
    sessionId: req.params.id,
    ...req.query,
  });

  await streamToSSE(res, stream, "session:events");
});

// Get session state
app.get("/session/:id", async (req, res) => {
  const state = await routes.getState({ sessionId: req.params.id });
  res.json(state);
});

// Delete session
app.delete("/session/:id", async (req, res) => {
  const result = await routes.deleteSession({ sessionId: req.params.id });
  res.json(result);
});
```

## Core Concepts

### Session Handler

The `SessionHandler` manages session lifecycle:

```typescript
const handler = createSessionHandler({
  app,                          // Your Tentickle app
  store: new InMemorySessionStore(), // Session storage
  defaultSessionOptions: {},    // Default options for new sessions
});

// Create session
const { sessionId, session } = await handler.create({
  sessionId: "optional-id",     // Generated if not provided
  messages: [...],              // Initial messages to queue
});

// Send to session (returns final result)
const result = await handler.send(sessionId, {
  props: { query: "Hello" },
  messages: [...],
});

// Stream events from session
for await (const event of handler.stream(sessionId, { props })) {
  console.log(event);
}

// Get session state
const state = handler.getState(sessionId);
// { sessionId, status, tick, queuedMessages }

// Delete session
handler.delete(sessionId);
```

### Session Store

The `SessionStore` protocol allows pluggable persistence:

```typescript
interface SessionStore {
  get(id: string): Session | undefined;
  set(id: string, session: Session): void;
  delete(id: string): boolean;
  list(): string[];
  has(id: string): boolean;
}
```

Built-in stores:

- **InMemorySessionStore** - For development/testing

Implement your own for production:

```typescript
class RedisSessionStore implements SessionStore {
  async get(id: string) {
    const data = await redis.get(`session:${id}`);
    return data ? deserialize(data) : undefined;
  }
  // ... other methods
}
```

### Channel Bridge

The `ChannelBridge` routes messages between transport (WebSocket/SSE) and sessions:

```typescript
const bridge = createChannelBridge({
  sessionHandler,
  channelService,  // Optional: for application channels
  autoJoinRooms: (meta) => [
    `user:${meta.userId}`,
    `session:${meta.sessionId}`,
  ],
});

// Register a connection (from WebSocket/SSE)
bridge.registerConnection({
  id: connectionId,
  metadata: { userId, sessionId },
  rooms: new Set(),
  send: (event) => ws.send(JSON.stringify(event)),
  close: () => ws.close(),
});

// Handle incoming messages
await bridge.handleMessage(connectionId, event);

// Broadcast to rooms
await bridge.broadcast("user:123", {
  channel: "notifications",
  type: "new_message",
  payload: { ... },
});

// Cleanup
bridge.unregisterConnection(connectionId);
```

### Framework Channels

Built-in channels for session communication:

| Channel | Purpose |
|---------|---------|
| `session:messages` | Client sends messages to session (starts execution) |
| `session:events` | Server streams events to client |
| `session:control` | Client sends control commands (tick, abort) |
| `session:result` | Server sends final result |
| `session:tool_confirmation` | Tool confirmation flow |

### SSE Utilities

Stream events to clients via Server-Sent Events:

```typescript
import {
  createSSEWriter,
  streamToSSE,
  setSSEHeaders,
} from "@tentickle/server";

// Option 1: Manual control
app.get("/events", (req, res) => {
  setSSEHeaders(res);

  const writer = createSSEWriter(res, {
    keepaliveInterval: 15000,
    eventName: "message",
  });

  // Write events
  writer.writeEvent({
    channel: "session:events",
    type: "content_delta",
    payload: { delta: "Hello" },
  });

  // Close when done
  writer.close();
});

// Option 2: Stream an async iterable
app.get("/stream", async (req, res) => {
  setSSEHeaders(res);

  const events = sessionHandler.stream(sessionId, { props });
  await streamToSSE(res, events, "session:events");
});
```

## API Reference

### createSessionHandler(config)

Create a session handler.

```typescript
interface SessionHandlerConfig {
  app: App;                    // Tentickle app
  store?: SessionStore;        // Session storage (default: InMemorySessionStore)
  defaultSessionOptions?: {};  // Default session options
}
```

### createChannelBridge(config)

Create a channel bridge for routing.

```typescript
interface ChannelBridgeConfig {
  sessionHandler: SessionHandler;
  channelService?: any;        // For application channels
  autoJoinRooms?: (metadata: ConnectionMetadata) => string[];
}
```

### createSessionRoutes(config)

Create framework-agnostic route handlers.

```typescript
interface SessionRoutes {
  createSession(input: CreateSessionInput): Promise<{ sessionId, status }>;
  send(input: { sessionId } & SendInput): Promise<{ response, usage }>;
  stream(input: { sessionId } & SendInput): AsyncIterable<StreamEvent>;
  getState(input: { sessionId }): Promise<SessionState>;
  deleteSession(input: { sessionId }): Promise<{ deleted }>;
  channelPublish(input: ChannelPublishInput): Promise<{ success }>;
}
```

### SSE Functions

```typescript
// Set SSE headers on response
setSSEHeaders(res: { setHeader: Function }): void;

// Create SSE writer for manual control
createSSEWriter(
  stream: { write: Function, end: Function },
  options?: SSEWriterOptions
): SSEWriter;

// Stream async iterable to SSE
streamToSSE<T>(
  stream: { write: Function, end: Function },
  events: AsyncIterable<T>,
  channel: string,
  options?: SSEWriterOptions
): Promise<void>;
```

## Philosophy

This package follows the "React, not Rails" philosophy:

- **Provides primitives, not opinions** - You decide how to persist, authenticate, and structure
- **Framework-agnostic** - Works with any HTTP framework
- **Composable** - Mix and match components as needed
- **Production-ready** - Built for real-world deployments

For a complete example, see the [example](../../example) directory.
