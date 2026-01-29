# @tentickle/express Architecture

Express integration that wraps `@tentickle/server` with a pre-configured router.

## Philosophy

**One function, batteries included.**

Users shouldn't need to understand SSE, event bridges, or connection management. They call `createTentickleRouter()` and get working endpoints.

```typescript
const { router } = createTentickleRouter({ app: myTentickleApp });
app.use("/api", router);
// Done. All routes work.
```

## Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions | Create session |
| GET | /sessions/:sessionId | Get session state |
| DELETE | /sessions/:sessionId | Delete session |
| GET | /events | SSE stream (query: sessionId) |
| POST | /events | Send event to session |

All paths are customizable via `paths` config.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Express App                        │
│                                                             │
│   app.use("/api", router)                                   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                   @tentickle/express                         │
│                                                             │
│   createTentickleRouter()                                   │
│       │                                                     │
│       ├── Creates SessionHandler (or uses provided)         │
│       ├── Creates EventBridge (or uses provided)            │
│       ├── Mounts session routes                             │
│       ├── Mounts event routes                               │
│       └── Returns { router, sessionHandler, eventBridge }   │
│                                                             │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                    @tentickle/server                         │
│                                                             │
│   SessionHandler, EventBridge, SSE utilities                │
└─────────────────────────────────────────────────────────────┘
```

## Authentication

Two hooks for auth integration:

```typescript
createTentickleRouter({
  app,
  // Extract token from request
  authenticate: (req) => req.headers.authorization?.replace("Bearer ", ""),
  // Extract user ID (can use req.user set by your auth middleware)
  getUserId: (req) => (req as any).user?.id,
});
```

The router doesn't enforce auth - it just extracts credentials and passes them to the session/connection metadata. Use your own Express middleware for actual auth enforcement.

## SSE Connection Flow

```
Client                           Server
  │                                │
  │─── GET /events?sessionId=x ───▶│
  │                                │
  │◀─── SSE: connected ────────────│
  │◀─── SSE: keepalive ────────────│  (every 15s)
  │◀─── SSE: event ────────────────│
  │◀─── SSE: event ────────────────│
  │                                │
  │─── POST /events ──────────────▶│  (client sends event)
  │◀─── { success: true } ─────────│
```

## Event Sending Modes

POST /events accepts two modes:

**With connectionId** (for established SSE connections):
```json
{
  "connectionId": "conn-123",
  "channel": "session:control",
  "type": "tick",
  "payload": {}
}
```

**With sessionId** (ephemeral, for one-off requests):
```json
{
  "sessionId": "session-456",
  "channel": "session:messages",
  "type": "message",
  "payload": { "role": "user", "content": [...] }
}
```

## Cleanup

Call `destroy()` on server shutdown:

```typescript
const { router, destroy } = createTentickleRouter({ app });

process.on("SIGTERM", () => {
  destroy();  // Closes all SSE connections, cleans up EventBridge
  server.close();
});
```

## File Structure

```
packages/express/src/
├── index.ts    # Exports
├── types.ts    # Config and type definitions
└── router.ts   # Router factory (~200 lines)
```

## What This Doesn't Do

- **Auth enforcement** - Use Express middleware
- **Rate limiting** - Use express-rate-limit or similar
- **CORS** - Use cors middleware
- **Body parsing** - Use express.json() middleware

We handle Tentickle-specific concerns. Standard Express concerns are yours.
