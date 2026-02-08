# Channels Module Architecture

> **Streaming communication infrastructure for Agentick applications**

The channels module provides a layered communication system for real-time, bidirectional data streaming between Agentick backends and clients. It builds on the kernel's `Channel` primitive to offer session management, transport abstraction, distributed scaling, and declarative event routing.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Layers](#architecture-layers)
3. [Core Components](#core-components)
4. [Data Flow](#data-flow)
5. [Transport Layer](#transport-layer)
6. [Distribution Layer](#distribution-layer)
7. [Channel Router](#channel-router)
8. [Usage Patterns](#usage-patterns)
9. [Integration Points](#integration-points)

---

## Overview

### What This Module Does

The channels module provides:

- **Session Management** - User+conversation scoped channel sessions that persist across engine executions
- **Transport Abstraction** - Pluggable transports for external communication (WebSocket, Socket.io, Streamable HTTP)
- **Distribution Support** - Multi-instance scaling via Redis pub/sub
- **Room-based Routing** - Socket.io-inspired room semantics for targeted message delivery
- **Declarative Event Handling** - `ChannelRouter` for type-safe, declarative event handling with auto-notification

### Why It Exists

Agentick applications need real-time communication between:

- Backend agents publishing streaming results
- Frontend clients receiving updates and sending user input
- Tools requesting user confirmation or input
- Multiple server instances in distributed deployments

The channels module provides a unified abstraction that works locally, scales horizontally, and supports multiple transport protocols.

### Relationship to Kernel Channel

The kernel provides the low-level `Channel` primitive:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Kernel (@agentick/kernel)                                               │
│  ├── Channel - EventEmitter-based pub/sub                           │
│  ├── ChannelSession - Collection of channels scoped to user+conv    │
│  └── ChannelServiceInterface - Contract for channel access          │
├─────────────────────────────────────────────────────────────────────┤
│  Core Channels Module (this module)                                 │
│  ├── ChannelService - Implements ChannelServiceInterface            │
│  ├── ChannelRouter - Declarative event handling                     │
│  ├── Transports - WebSocket, Socket.io, Streamable HTTP             │
│  └── Adapters - Redis for multi-instance distribution               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Layers

The channels module follows a layered architecture:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Application Layer (recommended)                                    │
│  └── ChannelRouter - declarative handlers, context registry,        │
│                      auto-notifications, scoped publishing          │
├─────────────────────────────────────────────────────────────────────┤
│  Service Layer (escape hatch)                                       │
│  └── ChannelService - sessions, direct publish/subscribe,           │
│                       transport & adapter management                │
├─────────────────────────────────────────────────────────────────────┤
│  Infrastructure Layer                                               │
│  ├── Transport - external communication (SSE, WebSocket)            │
│  └── Adapter - multi-instance distribution (Redis pub/sub)          │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer          | Component          | Responsibility                                                            |
| -------------- | ------------------ | ------------------------------------------------------------------------- |
| Application    | `ChannelRouter`    | Declarative event handlers, execution context registry, scoped publishing |
| Service        | `ChannelService`   | Session lifecycle, channel access, transport/adapter coordination         |
| Infrastructure | `ChannelTransport` | External communication protocols                                          |
| Infrastructure | `ChannelAdapter`   | Multi-instance distribution                                               |

---

## Core Components

### ChannelService

The `ChannelService` implements `ChannelServiceInterface` from the kernel and manages:

1. **Session Lifecycle** - Creates, tracks, and cleans up `ChannelSession` instances
2. **Channel Access** - Provides `getChannel()` for accessing named channels within sessions
3. **Event Publishing** - Enriches events with metadata and forwards to transport/adapter
4. **Subscription Management** - Handles subscriptions with filtering options

```typescript
interface ChannelServiceConfig {
  sessionIdGenerator?: (ctx: EngineContext) => string; // Custom session ID logic
  transport?: ChannelTransport; // External communication
  adapter?: ChannelAdapter; // Multi-instance distribution
  sessionTimeout?: number; // Cleanup timeout (default: 1 hour)
  routers?: ChannelRouter<any>[]; // Declarative handlers
}
```

**Session ID Generation:**
Default: `{userId}-{conversationId}` (falls back to traceId if no conversationId)

### ChannelTransport Interface

Transports handle external client communication:

```typescript
interface ChannelTransport {
  name: string;

  // Connection lifecycle
  connect(connectionId: string, metadata?: ConnectionMetadata): Promise<void>;
  disconnect(connectionId?: string): Promise<void>;
  closeAll(): void;

  // Event flow
  send(event: ChannelEvent): Promise<void>;
  onReceive(handler: (event: ChannelEvent) => void): void;

  // Room support (optional but recommended)
  join?(connectionId: string, room: string): Promise<void>;
  leave?(connectionId: string, room: string): Promise<void>;
  getConnectionRooms?(connectionId: string): string[];
  getRoomConnections?(room: string): string[];
}
```

### ChannelAdapter Interface

Adapters handle multi-instance distribution:

```typescript
interface ChannelAdapter {
  name: string;

  // Event distribution
  publish(event: ChannelEvent): Promise<void>;
  subscribe(channel: string, handler: (event: ChannelEvent) => void): Promise<() => void>;

  // Room support (optional)
  joinRoom?(room: string): Promise<void>;
  leaveRoom?(room: string): Promise<void>;
  close?(): Promise<void>;
}
```

### ChannelRouter

Declarative event handling with execution context awareness:

```typescript
class ChannelRouter<TSubscribeContext> {
  channel: string;

  // Handler registration (fluent API)
  on(eventType: string, handler: ChannelEventHandler<TSubscribeContext>): this;
  default(handler: ChannelEventHandler<TSubscribeContext>): this;
  onError(handler: (error: Error, event: ChannelEvent) => void): this;

  // Event handling
  handle<TResult>(event: ChannelEvent, context: TSubscribeContext): Promise<TResult | undefined>;

  // Context registry
  registerContext(
    ctx: EngineContext,
    channelContext: TSubscribeContext,
    onEvent?: ContextEventCallback,
  ): ChannelPublisher;
  unregisterContext(ctx: EngineContext): void;
  forEachContext(scope: string | TSubscribeContext, fn: (ctx: TSubscribeContext) => void): void;

  // Publishing
  publisher(): ChannelPublisher;
}
```

---

## Data Flow

### Single-Instance Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Single Instance                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────┐        ┌─────────────────┐        ┌────────────┐  │
│   │   Engine    │──────▶│  ChannelService  │───-───▶│  Transport │  │
│   │  publish()  │        │                 │        │  (WS/SSE)  │  │
│   └─────────────┘        │  ┌───────────┐  │        └─────┬──────┘  │
│                          │  │ Session   │  │              │         │
│                          │  │  ┌─────┐  │  │              ▼         │
│                          │  │  │Chan │  │  │        ┌────────────┐  │
│                          │  │  └─────┘  │  │        │   Client   │  │
│                          │  └───────────┘  │        └────────────┘  │
│                          └─────────────────┘                        │
│                                                                     │
│   Flow:                                                             │
│   1. Engine calls channelService.publish(ctx, 'channel', event)     │
│   2. ChannelService gets/creates session for context                │
│   3. Event published to local Channel (EventEmitter)                │
│   4. Event forwarded to Transport for external delivery             │
│   5. Client receives event via WebSocket/SSE                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Multi-Instance Flow with Redis

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Distributed Deployment                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Instance A                              Instance B                 │
│  ┌────────────────────────┐              ┌────────────────────────┐ │
│  │ Engine                 │              │ Engine                 │ │
│  │   ↓                    │              │   ↓                    │ │
│  │ ChannelService         │              │ ChannelService         │ │
│  │   ↓           ↓        │              │   ↓           ↓        │ │
│  │ Transport   Adapter────┼──────────────┼──Adapter   Transport   │ │
│  │   ↓           ↓        │              │   ↓           ↓        │ │
│  └───┼───────────┼────────┘              └───┼───────────┼────────┘ │
│      │           │                           │           │          │
│      ▼           └───────────┬───────────────┘           ▼          │
│  Client A                    │                       Client B       │
│                              ▼                                      │
│                     ┌─────────────────┐                             │
│                     │   Redis PubSub  │                             │
│                     │                 │                             │
│                     │  Channels:      │                             │
│                     │  agentick:rooms:*   │                             │
│                     │  agentick:channels:*│                             │
│                     └─────────────────┘                             │
│                                                                     │
│  Flow for room-targeted message:                                    │
│  1. Instance A publishes event with target.rooms = ['user:alice']   │
│  2. Adapter publishes to Redis channel 'agentick:rooms:user:alice'      │
│  3. Instance B (subscribed to room) receives from Redis             │
│  4. Instance B delivers to Client B (in room 'user:alice')          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Room-Based Routing

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Room-Based Message Routing                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Scope Configuration:                                               │
│  { user: 'userId', thread: 'threadId' }                             │
│                                                                     │
│  Context: { userId: 'alice', threadId: '123' }                      │
│                                                                     │
│  Derived Rooms: ['user:alice', 'thread:123']                        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                        Server                                │   │
│  │                                                              │   │
│  │    Room: user:alice           Room: thread:123               │   │
│  │    ┌─────────────────┐        ┌─────────────────┐            │   │
│  │    │ - Client A      │        │ - Client A      │            │   │
│  │    │ - Client C      │        │ - Client B      │            │   │
│  │    └─────────────────┘        └─────────────────┘            │   │
│  │                                                              │   │
│  │    publisher.scope('user').to('alice').broadcast(event)      │   │
│  │    → Sends to room 'user:alice' → Clients A & C              │   │
│  │                                                              │   │
│  │    publisher.scope('thread').to('123').broadcast(event)      │   │
│  │    → Sends to room 'thread:123' → Clients A & B              │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Broadcast Pattern (excludeSender):                                 │
│  - Client A sends update via HTTP                                   │
│  - Server broadcasts to room with excludeSender: true               │
│  - All clients in room EXCEPT A receive the update                  │
│  - A already has the update (optimistic UI)                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Transport Layer

### Available Transports

| Transport                 | Direction     | Use Case                                      |
| ------------------------- | ------------- | --------------------------------------------- |
| `WebSocketTransport`      | Bidirectional | Full-duplex real-time communication           |
| `SocketIOTransport`       | Bidirectional | Native room support, reconnection handling    |
| `StreamableHTTPTransport` | Bidirectional | SSE for server→client, POST for client→server |

### WebSocketTransport

```typescript
const transport = new WebSocketTransport({
  url: "wss://api.example.com/ws",
  token: "auth-token",
  reconnectDelay: 1000,
  maxReconnectAttempts: 10,
  autoJoinRooms: (meta) => [meta.userId && `user:${meta.userId}`].filter(Boolean),
});
```

**Features:**

- Works in browser (native WebSocket) and Node.js (`ws` package)
- Automatic reconnection with exponential backoff
- Room join/leave via messages to server
- Supports existing socket injection

### SocketIOTransport

```typescript
const transport = new SocketIOTransport({
  url: "https://api.example.com",
  token: "auth-token",
  options: {
    transports: ["websocket"],
    reconnection: true,
  },
  autoJoinRooms: (meta) => [meta.userId && `user:${meta.userId}`].filter(Boolean),
});
```

**Features:**

- Native Socket.io room support
- Built-in reconnection
- Multiplexing and fallback transports

### StreamableHTTPTransport

```typescript
const transport = new StreamableHTTPTransport({
  url: "https://api.example.com/channels",
  token: "auth-token",
  timeout: 30000,
  autoJoinRooms: (meta) => [meta.userId && `user:${meta.userId}`].filter(Boolean),
});
```

**Architecture:**

- Server → Client: Server-Sent Events (SSE) at `/sse`
- Client → Server: HTTP POST at `/events`
- Room management: POST to `/rooms/join` and `/rooms/leave`

**Features:**

- Works through HTTP proxies and load balancers
- No persistent connection required for sending
- Browser and Node.js compatible

---

## Distribution Layer

### RedisChannelAdapter

```typescript
const adapter = new RedisChannelAdapter({
  url: "redis://localhost:6379",
  // or individual options:
  host: "localhost",
  port: 6379,
  password: "secret",
  db: 0,
  channelPrefix: "agentick:channels:",
  roomPrefix: "agentick:rooms:",
});
```

**Channel Naming:**

- Default channels: `agentick:channels:{channelName}`
- Room channels: `agentick:rooms:{roomName}`

**Flow:**

1. Event with `target.rooms` publishes to room Redis channels
2. Each instance subscribes to rooms it has local connections for
3. Received events are forwarded to local transports

**Cleanup:**

- `joinRoom(room)` - Subscribe when first local connection joins
- `leaveRoom(room)` - Unsubscribe when last local connection leaves
- `close()` - Cleanup all subscriptions

---

## Channel Router

### Declarative Event Handling

```typescript
// Define router with scope mapping
const todoChannel = new ChannelRouter<TodoContext>("todo-list", {
  scope: { user: "userId" },
})
  .on("create_task", async (event, ctx) => {
    const task = await TodoService.createTask(ctx.userId, event.payload);
    return { success: true, task };
  })
  .on("delete_task", async (event, ctx) => {
    await TodoService.deleteTask(ctx.userId, event.payload.taskId);
    return { success: true };
  })
  .default(async (event, ctx) => {
    console.warn(`Unhandled event type: ${event.type}`);
  })
  .onError((error, event) => {
    console.error(`Error handling ${event.type}:`, error);
  });
```

### Scope Configuration

```typescript
// Single scope - maps userId field to 'user' prefix
scope: {
  user: "userId";
}
// Context { userId: 'alice' } → scope key 'user:alice'

// Multiple scopes
scope: [{ user: "userId" }, { thread: "threadId" }];
// Context { userId: 'alice', threadId: '123' } → ['user:alice', 'thread:123']

// Function scope (for complex logic)
scope: (ctx) => `user:${ctx.userId}`;
scope: (ctx) => [`user:${ctx.userId}`, `org:${ctx.orgId}`];
```

### Context Registry

Components register to receive automatic notifications when handlers complete:

```typescript
// In component
const publisher = channel.registerContext(ctx, { userId }, (event, result) => {
  if (result?.success) {
    component.setState("tasks", result.tasks);
  }
});

// Publish events
publisher.to(userId).broadcast({ type: "state_changed", payload });

// Cleanup on unmount
channel.unregisterContext(ctx);
```

**Auto-cleanup:**
Contexts are automatically cleaned up when the execution ends (via `executionHandle` events).

### Scoped Publishing

```typescript
// Get publisher (no subscription required)
const publisher = channel.publisher();

// Select scope and target
publisher.scope("user").to(userId).broadcast(event); // → room 'user:{userId}'
publisher.scope("thread").to(threadId).send(event); // → room 'thread:{threadId}'

// Direct .to() uses first scope key
publisher.to(userId).broadcast(event); // → room 'user:{userId}'
```

**send vs broadcast:**

- `send(event)` - Direct send (includes sender)
- `broadcast(event)` - Excludes sender (for UI updates)

---

## Usage Patterns

### Basic Channel Service Usage

```typescript
// Create service with transport
const channelService = new ChannelService({
  transport: new WebSocketTransport({ url: "wss://api.example.com/ws" }),
});

// Publish event
channelService.publish(ctx, "notifications", {
  type: "new_message",
  payload: { from: "alice", text: "Hello!" },
});

// Subscribe to events
const unsubscribe = channelService.subscribe(ctx, "notifications", (event) => {
  console.log("Received:", event.type, event.payload);
});

// Wait for response (bidirectional)
const requestId = crypto.randomUUID();
channelService.publish(ctx, "user-input", {
  type: "request",
  id: requestId,
  payload: { prompt: "Confirm action?" },
});
const response = await channelService.waitForResponse(ctx, "user-input", requestId, 30000);
```

### Engine Integration

```typescript
// Create engine with channel routers
const engine = createEngine({
  channels: {
    transport: new WebSocketTransport({ ... }),
    adapter: new RedisChannelAdapter({ ... }),
    routers: [todoChannel, notificationChannel],
  },
});

// Handle events from HTTP routes
app.post('/api/channels/:channel', async (req, res) => {
  const result = await engine.channels?.handleEvent(
    req.params.channel,
    { type: req.body.type, payload: req.body.payload },
    { userId: req.user.id, broadcast: true }
  );
  res.json({ success: true, ...result });
});
```

### Tool Requesting User Input

```typescript
// In a tool
async function askUserConfirmation(message: string): Promise<boolean> {
  const ctx = Context.get();
  const requestId = crypto.randomUUID();

  // Publish request
  publishChannel("user:input", {
    type: "request",
    id: requestId,
    payload: { message, type: "confirm" },
  });

  // Wait for response
  const response = await waitForChannelResponse("user:input", requestId, 60000);
  return response.payload.confirmed;
}
```

### Component State Synchronization

```typescript
// Define channel router
const scratchpadChannel = new ChannelRouter<{ userId: string }>("scratchpad", {
  scope: { user: "userId" },
}).on("update_notes", async (event, ctx) => {
  const notes = await ScratchpadService.updateNotes(ctx.userId, event.payload);
  return { notes };
});

// In AI component
function onMount(ctx: EngineContext, com: ComponentHandle) {
  const publisher = scratchpadChannel.registerContext(ctx, { userId }, (event, result) => {
    if (result?.notes) {
      ctx.setState("notes", result.notes);
    }
  });
}

function onUnmount(ctx: EngineContext, com: ComponentHandle) {
  scratchpadChannel.unregisterContext(ctx);
}
```

---

## Integration Points

### With Engine

```typescript
// Engine injects ChannelService into context
const engine = createEngine({
  channels: {
    transport: new WebSocketTransport({ ... }),
    routers: [myRouter],
  },
});

// Access in procedures
const ctx = Context.get();
const channel = ctx.channels?.getChannel(ctx, 'my-channel');
```

### With HTTP Framework

```typescript
// Express example
app.post("/api/channels/:channel/events", async (req, res) => {
  try {
    const result = await engine.channels?.handleEvent(
      req.params.channel,
      { type: req.body.type, payload: req.body.payload },
      { userId: req.user.id },
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// SSE endpoint
app.get("/api/channels/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const transport = engine.channels?.getTransport();
  // Transport manages SSE stream...
});
```

### With Frontend Clients

```typescript
// React/Angular client
const transport = new WebSocketTransport({
  url: "wss://api.example.com/ws",
  token: authToken,
});

await transport.connect(sessionId, { userId });

transport.onReceive((event) => {
  switch (event.channel) {
    case "notifications":
      handleNotification(event);
      break;
    case "todo-list":
      handleTodoUpdate(event);
      break;
  }
});

// Send event
await transport.send({
  channel: "todo-list",
  type: "create_task",
  payload: { title: "New task" },
});
```

---

## File Structure

```
channels/
├── index.ts                    # Re-exports all public APIs
├── service.ts                  # ChannelService, ChannelRouter, interfaces
├── service.spec.ts             # ChannelService tests
├── adapters/
│   ├── index.ts                # Re-exports adapters
│   └── redis.ts                # RedisChannelAdapter
└── transports/
    ├── index.ts                # Re-exports transports
    ├── websocket.ts            # WebSocketTransport
    ├── socketio.ts             # SocketIOTransport
    └── streamable-http.ts      # StreamableHTTPTransport
```

---

## Summary

The channels module provides a complete streaming communication infrastructure:

- **ChannelService** manages sessions and coordinates local channels with external transports
- **ChannelRouter** enables declarative event handling with scope-based routing
- **Transports** (WebSocket, Socket.io, Streamable HTTP) handle external client communication
- **RedisChannelAdapter** enables horizontal scaling across multiple instances
- **Room-based routing** allows targeted message delivery with broadcast semantics

Use `ChannelRouter` for application code; fall back to `ChannelService` methods for advanced cases. The layered architecture ensures local development works seamlessly while production deployments can scale horizontally.
