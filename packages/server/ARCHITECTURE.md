# @tentickle/server Architecture

Server-side SDK for running Tentickle applications.

## Wire Protocol

> **All wire protocol types come from `@tentickle/shared`.**
>
> See [`@tentickle/shared/ARCHITECTURE.md`](../shared/ARCHITECTURE.md) for the protocol specification.

```typescript
// Protocol types - ALWAYS from shared, never duplicated
import type { ChannelEvent, SessionResultPayload } from "@tentickle/shared";
import { FrameworkChannels } from "@tentickle/shared";
```

## Design Philosophy

**This package provides hooks and handlers, NOT routes.**

Your web framework (Express, Fastify, Hono, etc.) defines routes that call into these handlers. This keeps the package framework-agnostic.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Web Framework                        │
│                  (Express, Fastify, etc.)                   │
│                                                             │
│   POST /sessions ──────▶ sessionHandler.create()            │
│   GET  /sessions/:id ──▶ sessionHandler.getState()          │
│   GET  /events ────────▶ eventBridge.registerConnection()   │
│   POST /events ────────▶ eventBridge.handleEvent()          │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                     @tentickle/server                        │
│                                                             │
│  ┌──────────────────┐       ┌──────────────────┐            │
│  │  SessionHandler  │◀─────▶│   EventBridge    │            │
│  │                  │       │                  │            │
│  │  create()        │       │  handleEvent()   │            │
│  │  send()          │       │  registerConn()  │            │
│  │  stream()        │       │  unregisterConn()│            │
│  │  getState()      │       │                  │            │
│  └────────┬─────────┘       └────────┬─────────┘            │
│           │                          │                      │
│  ┌────────▼─────────┐       ┌────────▼─────────┐            │
│  │   SessionStore   │       │   SSE Utilities  │            │
│  │   (pluggable)    │       │                  │            │
│  └──────────────────┘       └──────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### SessionHandler

Manages session lifecycle. Does NOT define routes.

```typescript
interface SessionHandler {
  create(input): Promise<{ sessionId, session }>;
  send(sessionId, input): Promise<SendResult>;
  stream(sessionId, input): AsyncIterable<StreamEvent>;
  getSession(sessionId): Session | undefined;
  getState(sessionId): SessionStateInfo | undefined;
  delete(sessionId): boolean;
  list(): string[];
}
```

### EventBridge

Routes events between transport connections and sessions.

**Two modes:**

1. **Without transport adapter (HTTP/SSE):** Manages connections internally
2. **With transport adapter (Socket.IO):** Delegates connection management to adapter

```typescript
interface EventBridge {
  // Accepts connectionId (string) OR connection (ServerConnection)
  handleEvent(connectionOrId, event): Promise<void>;
  registerConnection(connection): void;   // Only needed without adapter
  unregisterConnection(connectionId): void; // Only needed without adapter
  destroy(): void;
}
```

**HTTP/SSE mode:**
```typescript
const bridge = createEventBridge({ sessionHandler });
bridge.registerConnection(connection);  // You track connections
await bridge.handleEvent(connectionId, event);  // Looks up by ID
```

**Socket.IO mode:**
```typescript
const bridge = createEventBridge({ sessionHandler, transport: adapter });
// No registerConnection needed - adapter tracks via rooms
await bridge.handleEvent(connection, event);  // Pass connection directly
```

Handles framework channels automatically:
- `session:messages` → session.send() (starts execution + stream)
- `session:control` → tick or abort (optional)
- `session:tool_confirmation` → forwards to session

Notes:
- `tick` events with no queued messages and no props are ignored to prevent
  system-only runs.

### ServerConnection

Your framework creates these when clients connect:

```typescript
interface ServerConnection {
  readonly id: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly metadata: Record<string, unknown>;
  send(event): Promise<void>;
  close(): void;
}
```

### SessionStore

Pluggable session persistence:

```typescript
interface SessionStore {
  get(id: string): Session | undefined;
  set(id: string, session: Session): void;
  delete(id: string): boolean;
  list(): string[];
  has(id: string): boolean;
}
```

Built-in `InMemorySessionStore` for development. Implement your own for production (Redis, PostgreSQL, etc.).

### ServerTransportAdapter

For WebSocket or Socket.io support:

```typescript
interface ServerTransportAdapter {
  readonly name: string;
  registerConnection(connection): void;
  unregisterConnection(connectionId): void;
  sendToConnection(connectionId, event): Promise<void>;
  sendToSession(sessionId, event): Promise<void>;
  getSessionConnections(sessionId): ServerConnection[];
  destroy(): void;
}
```

## File Structure

```
packages/server/src/
├── index.ts           # Public exports
├── types.ts           # Server types (re-exports protocol from shared)
├── session-handler.ts # Session lifecycle management
├── session-store.ts   # In-memory store implementation
├── event-bridge.ts    # Event routing between transport and sessions
└── sse.ts             # SSE utilities
```

## Usage (Express Example)

```typescript
import express from "express";
import {
  createSessionHandler,
  createEventBridge,
  createSSEWriter,
  setSSEHeaders,
  InMemorySessionStore,
} from "@tentickle/server";

const app = express();

// Create handlers
const sessionHandler = createSessionHandler({
  app: myTentickleApp,
  store: new InMemorySessionStore(),
});

const eventBridge = createEventBridge({ sessionHandler });

// Define YOUR routes - the server package doesn't impose any
app.post("/sessions", async (req, res) => {
  const { sessionId } = await sessionHandler.create(req.body);
  res.json({ sessionId, status: "created" });
});

app.get("/sessions/:id", async (req, res) => {
  const state = sessionHandler.getState(req.params.id);
  if (!state) return res.status(404).json({ error: "Not found" });
  res.json(state);
});

// SSE endpoint for server → client events
app.get("/events", (req, res) => {
  const { sessionId, userId } = req.query;
  const connectionId = crypto.randomUUID();

  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  eventBridge.registerConnection({
    id: connectionId,
    sessionId,
    userId,
    metadata: {},
    send: async (event) => writer.writeEvent(event),
    close: () => writer.close(),
  });

  req.on("close", () => {
    eventBridge.unregisterConnection(connectionId);
  });
});

// POST endpoint for client → server events
app.post("/events", async (req, res) => {
  const { connectionId, ...event } = req.body;
  await eventBridge.handleEvent(connectionId, event);
  res.json({ success: true });
});
```

## Error Handling

```typescript
import { SessionNotFoundError, SessionClosedError } from "@tentickle/server";

try {
  await sessionHandler.send(sessionId, input);
} catch (error) {
  if (error instanceof SessionNotFoundError) {
    res.status(404).json({ error: "Session not found" });
  } else if (error instanceof SessionClosedError) {
    res.status(410).json({ error: "Session closed" });
  } else {
    res.status(500).json({ error: "Internal error" });
  }
}
```

### Structured Error Codes

The EventBridge sends structured errors with protocol error codes when streaming fails:

```typescript
// Error event sent to client
{
  channel: "session:events",
  type: "error",
  payload: {
    code: "SESSION_NOT_FOUND",  // or EXECUTION_ERROR, TIMEOUT, etc.
    message: "Session not found: xyz",
    details?: { cause: "..." }   // Optional additional context
  }
}
```

Available error codes (from `@tentickle/shared`):

| Code | Description |
|------|-------------|
| `SESSION_NOT_FOUND` | Session does not exist |
| `SESSION_CLOSED` | Session has been closed |
| `TIMEOUT` | Operation timed out |
| `INVALID_MESSAGE` | Invalid or malformed message |
| `EXECUTION_ERROR` | General execution error |
| `SERIALIZATION_ERROR` | Failed to serialize event payload |

### SSE Serialization Safety

The SSE writer handles JSON serialization errors gracefully. If `JSON.stringify()` fails (e.g., circular references, BigInt values), the writer:

1. Logs the error to console
2. Sends a fallback error event with `SERIALIZATION_ERROR` code
3. Continues streaming (doesn't close the connection)

```typescript
// If original event can't be serialized, client receives:
{
  channel: "original-channel",
  type: "error",
  payload: {
    code: "SERIALIZATION_ERROR",
    message: "Failed to serialize event: ..."
  }
}
```
