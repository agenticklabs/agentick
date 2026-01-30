# @tentickle/express Architecture

Express integration providing an **app-centric handler** for Tentickle servers.

## Philosophy

**One function, batteries included.**

Users call `createTentickleHandler(app)` with their Tentickle `App` instance and get a complete router with SSE multiplexing, session management, and authentication support.

```typescript
import { createTentickleHandler } from "@tentickle/express";

const app = createApp(MyAgent, { model });
const handler = createTentickleHandler(app);

expressApp.use("/api/agent", handler);
// Done. All routes work with multiplexed sessions.
```

## Routes

| Method | Path               | Description                         |
| ------ | ------------------ | ----------------------------------- |
| GET    | /events            | SSE stream (multiplexed sessions)   |
| POST   | /send              | Send message to session             |
| POST   | /subscribe         | Add/remove session subscriptions    |
| POST   | /abort             | Abort execution                     |
| POST   | /close             | Close session                       |
| POST   | /tool-response     | Submit tool confirmation            |
| POST   | /channel           | Publish event to session channel    |
| POST   | /channel/subscribe | Subscribe to session channel events |

All paths are customizable via `paths` config.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Express App                        │
│                                                              │
│   app.use("/api/agent", handler)                             │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                   @tentickle/express                          │
│                                                              │
│   createTentickleHandler(app, options)                       │
│       │                                                      │
│       ├── Manages SSE connections (connectionId → Response)  │
│       ├── Tracks session subscriptions per connection        │
│       ├── Routes events by sessionId to subscribers          │
│       └── Handles authentication/authorization hooks         │
│                                                              │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                    @tentickle/core                            │
│                                                              │
│   App<P> with SessionRegistry                                │
│       - send(input, { sessionId })                           │
│       - session(id)                                          │
│       - getOrCreateSession(id)                               │
│       - close(id)                                            │
└──────────────────────────────────────────────────────────────┘
```

## Multiplexed SSE

The handler manages **one SSE connection per client** that can receive events from **multiple sessions**:

```
Client                                  Server
   │                                       │
   │  GET /events                          │
   │───────────────────────────────────────►
   │                                       │
   │  SSE: {type:"connection",             │
   │        connectionId:"conn-123",       │
   │        subscriptions:[]}              │
   │◄───────────────────────────────────────
   │                                       │
   │  SSE: {type:"content_delta",          │
   │        sessionId:"conv-1", ...}       │
   │◄───────────────────────────────────────
   │                                       │
   │  POST /subscribe                      │
   │  {connectionId, add:["conv-2"]}       │
   │───────────────────────────────────────►
   │                                       │
   │  SSE: events for conv-1 AND conv-2    │
   │◄───────────────────────────────────────
```

## Authentication & Authorization

```typescript
createTentickleHandler(app, {
  // Extract user from request (runs on /events connection)
  authenticate: async (req) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return undefined;
    return verifyToken(token); // Returns user object or undefined
  },

  // Check if user can access session (runs on subscribe)
  authorize: async (user, sessionId, req) => {
    if (!user) return false;
    // e.g., session ID contains user ID
    return sessionId.startsWith(`user-${user.id}-`);
  },

  // Extract user ID for metadata
  getUserId: (req) => (req as any).user?.id,
});
```

The handler enforces authorization on subscribe operations - unauthorized attempts return 403.

## SSE Keepalive

The handler sends periodic SSE comments (`: keepalive`) to prevent proxy timeouts:

```typescript
createTentickleHandler(app, {
  keepaliveInterval: 15000, // Default: 15 seconds
});
```

## Request Flow

### GET /events

1. Authenticate user (if `authenticate` provided)
2. Generate unique `connectionId`
3. Set SSE headers
4. Send connection event with `connectionId`
5. Parse `?subscribe=a,b` query param
6. Subscribe to listed sessions (with authorization check)
7. Start keepalive timer
8. On disconnect: cleanup subscriptions

### POST /send

1. Validate input (`message` or `messages` required)
2. Get or create session if `sessionId` provided
3. Execute `app.send()` or `session.send()`
4. Stream events back as SSE response
5. Optionally route events to subscribers

### POST /subscribe

1. Validate `connectionId` exists
2. For each session in `add`: authorize and subscribe
3. For each session in `remove`: unsubscribe
4. Return success/error

### POST /abort

1. Validate `sessionId`
2. Get session from app
3. Call `session.interrupt()`
4. Return success/not found

### POST /close

1. Validate `sessionId`
2. Call `app.close(sessionId)`
3. Notify all subscribers
4. Return success

### POST /tool-response

1. Validate `sessionId` and `toolUseId`
2. Publish to session's tool confirmation channel
3. Return success

### POST /channel

1. Validate `sessionId`, `channel`, and `type`
2. Authorize access to session
3. Get session from app
4. Publish event to session's named channel
5. Return success/error

### POST /channel/subscribe

1. Validate `sessionId` and `channel`
2. Authorize access to session
3. Set up listener on session's named channel
4. Forward channel events to all subscribed SSE connections
5. Return success/error

## Handler Options

```typescript
interface TentickleHandlerOptions<User = unknown> {
  // Authentication
  authenticate?: (req: Request) => Promise<User | undefined> | User | undefined;
  authorize?: (user: User | undefined, sessionId: string, req: Request) => Promise<boolean> | boolean;
  getUserId?: (req: Request) => string | undefined;

  // Path customization
  paths?: {
    events?: string;       // Default: /events
    send?: string;         // Default: /send
    subscribe?: string;    // Default: /subscribe
    abort?: string;        // Default: /abort
    close?: string;        // Default: /close
    toolResponse?: string; // Default: /tool-response
    channel?: string;      // Default: /channel
  };

  // SSE
  keepaliveInterval?: number; // Default: 15000 (15 seconds)
}
```

## File Structure

```
packages/express/src/
├── index.ts    # Exports
├── types.ts    # Config and type definitions
└── router.ts   # Handler factory
```

## Usage Examples

### Basic Usage

```typescript
import express from "express";
import { createApp } from "@tentickle/core";
import { createTentickleHandler } from "@tentickle/express";

const app = createApp(MyAgent, { model });
const expressApp = express();

expressApp.use(express.json());
expressApp.use("/api/agent", createTentickleHandler(app));

expressApp.listen(3000);
```

### With Authentication

```typescript
expressApp.use("/api/agent", createTentickleHandler(app, {
  authenticate: async (req) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    return await verifyJWT(token);
  },
  authorize: (user, sessionId) => {
    return sessionId.startsWith(`user-${user.id}-`);
  },
}));
```

### Custom Paths

```typescript
expressApp.use("/chat", createTentickleHandler(app, {
  paths: {
    events: "/stream",
    send: "/message",
    subscribe: "/watch",
    abort: "/cancel",
    close: "/end",
    toolResponse: "/confirm",
  },
}));
```

## What This Doesn't Do

- **Rate limiting** - Use express-rate-limit or similar
- **CORS** - Use cors middleware
- **Body parsing** - Use express.json() middleware
- **Logging** - Use morgan or similar

We handle Tentickle-specific concerns. Standard Express concerns are yours.
