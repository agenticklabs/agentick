# @tentickle/express

Express router for Tentickle servers.

## Installation

```bash
npm install @tentickle/express
# or
pnpm add @tentickle/express
```

## Quick Start

```typescript
import express from "express";
import { createRouter } from "@tentickle/express";
import { createSessionHandler, createEventBridge } from "@tentickle/server";

const app = express();

const sessionHandler = createSessionHandler({
  createSession: async (props) => ({
    sessionId: crypto.randomUUID(),
    props,
  }),
  getSession: async (id) => sessions.get(id),
});

const eventBridge = createEventBridge();

app.use("/api/tentickle", createRouter({ sessionHandler, eventBridge }));

app.listen(3000);
```

## API

### createRouter(options)

Creates an Express router with Tentickle endpoints.

```typescript
const router = createRouter({
  sessionHandler,  // Required: SessionHandler instance
  eventBridge,     // Required: EventBridge instance
  paths: {         // Optional: customize endpoint paths
    sessions: "/sessions",
    events: "/events",
  },
});
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create new session |
| GET | `/sessions/:id` | Get session by ID |
| POST | `/sessions/:id/messages` | Send message to session |
| POST | `/sessions/:id/tick` | Trigger tick |
| POST | `/sessions/:id/abort` | Abort execution |
| GET | `/events` | SSE stream for events |
| POST | `/events` | Publish event to session |

## Usage

### With Authentication Middleware

```typescript
import { authenticateUser } from "./auth";

app.use("/api/tentickle", authenticateUser, createRouter({
  sessionHandler,
  eventBridge,
}));
```

### Custom Paths

```typescript
const router = createRouter({
  sessionHandler,
  eventBridge,
  paths: {
    sessions: "/s",
    events: "/e",
  },
});
// Results in: /s, /s/:id, /e, etc.
```

### Error Handling

The router returns appropriate HTTP status codes:

- `200` - Success
- `201` - Created (new session)
- `400` - Bad request (missing required fields)
- `404` - Session not found
- `500` - Internal server error

## License

MIT
