# Tentickle Example - Express + Gateway

This example demonstrates two different ways to serve a Tentickle agent:

1. **Express Server** (`server.ts`) - Traditional REST API with Express routes
2. **Gateway Server** (`gateway.ts`) - Standalone Gateway with custom methods

Both provide the same functionality (todo list + AI assistant) through different mechanisms.

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment file and add your API keys
cp .env.example .env

# Run Express server (port 3000)
pnpm dev

# OR run Gateway server (ports 18789/18790)
pnpm gateway

# OR run both simultaneously
pnpm both
```

## Architecture Overview

Both servers expose the **same REST API**, so the React app works with either one unchanged.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                            │
│              Uses REST API - works with both servers                │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌────────────────────────────┐         ┌────────────────────────────────┐
│     Express Server         │         │        Gateway Server          │
│     (port 3000)            │         │  WebSocket: 18789, HTTP: 18790 │
├────────────────────────────┤         ├────────────────────────────────┤
│  REST Routes:              │         │  REST Routes (same API):       │
│  GET  /api/tasks           │         │  GET  /api/tasks               │
│  POST /api/tasks           │         │  POST /api/tasks               │
│  PATCH /api/tasks/:id      │         │  PATCH /api/tasks/:id          │
│  DELETE /api/tasks/:id     │         │  DELETE /api/tasks/:id         │
│  POST /api/tasks/:id/complete        │  POST /api/tasks/:id/complete  │
│  POST /api/sessions        │         │  POST /api/sessions            │
│  GET  /api/sessions/:id    │         │  GET  /api/sessions/:id        │
│                            │         │                                │
│  Chat:                     │         │  Chat:                         │
│  GET  /api/events (SSE)    │         │  GET  /api/events (SSE)        │
│  POST /api/send            │         │  POST /api/send                │
│                            │         │                                │
│                            │         │  Gateway-specific:             │
│                            │         │  POST /api/invoke (RPC)        │
│                            │         │  ws://...  (WebSocket)         │
└────────────────────────────┘         └────────────────────────────────┘
```

## Server Comparison

| Feature   | Express Server       | Gateway Server              |
| --------- | -------------------- | --------------------------- |
| Port      | 3000                 | 18789 (WS), 18790 (HTTP)    |
| REST API  | Native routes        | Delegated to custom methods |
| RPC API   | Not available        | `/api/invoke`               |
| WebSocket | Not available        | Port 18789                  |
| Chat API  | `/api/send`          | `/api/send`                 |
| Events    | SSE at `/api/events` | SSE at `/api/events`        |
| DevTools  | Port 3002            | Port 3002                   |

## Testing from Backend (curl)

### Express Server (port 3000)

```bash
# Health check
curl http://localhost:3000/health

# Create a session
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session"}'

# List todos
curl "http://localhost:3000/api/tasks?sessionId=test-session"

# Create a todo
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy groceries", "sessionId": "test-session"}'

# Update a todo
curl -X PATCH http://localhost:3000/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy organic groceries", "sessionId": "test-session"}'

# Complete a todo
curl -X POST http://localhost:3000/api/tasks/1/complete \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session"}'

# Delete a todo
curl -X DELETE "http://localhost:3000/api/tasks/1?sessionId=test-session"

# Send a chat message (returns SSE stream)
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session",
    "message": {"role": "user", "content": [{"type": "text", "text": "Hello!"}]}
  }'

# Subscribe to SSE events
curl -N "http://localhost:3000/api/events?sessionId=test-session"
```

### Gateway Server (port 18790)

The Gateway supports the **same REST API** as Express, so you can use identical curl commands:

```bash
# REST-style (same as Express, just different port)
curl -X POST http://localhost:18790/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session"}'

curl "http://localhost:18790/api/tasks?sessionId=test-session"

curl -X POST http://localhost:18790/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy groceries", "sessionId": "test-session"}'
```

The Gateway also supports RPC-style invocation for custom methods:

```bash
# RPC-style (Gateway-specific)
curl -X POST http://localhost:18790/api/invoke \
  -H "Content-Type: application/json" \
  -d '{"method": "health"}'

curl -X POST http://localhost:18790/api/invoke \
  -H "Content-Type: application/json" \
  -d '{"method": "tasks:list", "params": {"sessionId": "test-session"}}'

curl -X POST http://localhost:18790/api/invoke \
  -H "Content-Type: application/json" \
  -d '{"method": "tasks:create", "params": {"title": "Buy groceries", "sessionId": "test-session"}}'
```

Chat and SSE work the same way:

```bash
# Send a chat message (returns SSE stream)
curl -X POST http://localhost:18790/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session",
    "message": {"role": "user", "content": [{"type": "text", "text": "Hello!"}]}
  }'

# Subscribe to SSE events
curl -N "http://localhost:18790/api/events?sessionId=test-session"
```

## Testing from Frontend (React/TypeScript)

### REST API (Works with Both Servers)

The same REST code works with both Express and Gateway servers - just change the port:

```typescript
// Works with Express (3000) or Gateway (18790)
const API_BASE = "http://localhost:3000/api";  // or :18790

// Create session
const { sessionId } = await fetch(`${API_BASE}/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: "my-session" }),
}).then(r => r.json());

// CRUD with REST
const { todos } = await fetch(`${API_BASE}/tasks?sessionId=${sessionId}`).then(r => r.json());

await fetch(`${API_BASE}/tasks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "New task", sessionId }),
});

// SSE for real-time events
const eventSource = new EventSource(`${API_BASE}/events?sessionId=${sessionId}`);
eventSource.onmessage = (e) => {
  const event = JSON.parse(e.data);
  console.log("Event:", event);
};

// Chat via POST (response is SSE stream)
const response = await fetch(`${API_BASE}/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sessionId,
    message: { role: "user", content: [{ type: "text", text: "Hello!" }] },
  }),
});

// Read streaming response
const reader = response.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

### Using TentickleClient (Gateway-specific features)

```typescript
import { createClient } from "@tentickle/client";

const client = createClient({
  baseUrl: "http://localhost:18790/api",
});

// Get session accessor
const session = client.session("my-session");

// CRUD with invoke()
const { todos } = await session.invoke<{ todos: Todo[] }>("tasks:list");

await session.invoke("tasks:create", { title: "New task" });

await session.invoke("tasks:update", { id: 1, completed: true });

await session.invoke("tasks:delete", { id: 1 });

// Chat with send()
for await (const event of session.send("Hello!")) {
  if (event.type === "text_delta") {
    console.log(event.text);
  }
}

// Or listen to all events
session.on("*", (event) => {
  console.log("Event:", event);
});
```

## File Structure

```
src/
├── server.ts           # Express server entry point
├── gateway.ts          # Gateway server entry point
├── setup.ts            # Shared Tentickle app configuration
├── agents/
│   └── assistant.tsx   # AI assistant component
├── routes/
│   └── todos.ts        # Express REST routes for todos
├── services/
│   └── todo-list.service.ts  # In-memory todo storage
└── tools/
    └── index.ts        # AI tools (add/complete/list todos)
```

## Environment Variables

```bash
# .env
PORT=3000                    # Express server port
GATEWAY_PORT=18789           # Gateway WebSocket port
HTTP_PORT=18790              # Gateway HTTP port
DEVTOOLS_PORT=3002           # DevTools UI port

# API Keys (at least one required)
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
ANTHROPIC_API_KEY=...

# Optional: Gateway authentication
GATEWAY_TOKEN=my-secret-token
```

## When to Use Each Approach

### Use Express Server when:

- You have an existing Express application
- You need fine-grained control over routes and middleware
- Your frontend already uses REST patterns
- You want to add Tentickle to specific routes only

### Use Gateway Server when:

- You're building a new application
- You want a unified RPC-style API
- You need WebSocket support for CLI tools
- You want built-in session management
- You prefer the `client.invoke()` pattern
