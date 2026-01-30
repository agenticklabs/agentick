# @tentickle/server Architecture

Server-side utilities for Tentickle applications.

## Wire Protocol

> **All wire protocol types come from `@tentickle/shared`.**
>
> See [`@tentickle/shared/ARCHITECTURE.md`](../shared/ARCHITECTURE.md) for the protocol specification.

```typescript
// Protocol types - ALWAYS from shared, never duplicated
import type { StreamEvent, SendInput, Message } from "@tentickle/shared";
```

## Design Philosophy

**This package provides SSE utilities and type re-exports.**

The actual session management is handled by `@tentickle/core` (`App`, `Session`).
Framework integration is handled by `@tentickle/express` (or other adapters).

This package is kept minimal - just the utilities that multiple adapters might need.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    @tentickle/express                        │
│                    @tentickle/nestjs                         │
│                    @tentickle/socket.io                      │
│                                                              │
│   createTentickleHandler(app) / modules                      │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                     @tentickle/server                         │
│                                                              │
│   ┌──────────────────┐       ┌──────────────────┐            │
│   │  SSE Utilities   │       │  Type Re-exports │            │
│   │                  │       │                  │            │
│   │  createSSEWriter │       │  from @shared    │            │
│   │  setSSEHeaders   │       │  SessionState    │            │
│   │  streamToSSE     │       │  StreamEvent     │            │
│   └──────────────────┘       └──────────────────┘            │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                     @tentickle/core                           │
│                                                              │
│   App, Session, SessionRegistry                              │
└──────────────────────────────────────────────────────────────┘
```

## Key Components

### SSE Utilities

Helpers for Server-Sent Events:

```typescript
import { createSSEWriter, setSSEHeaders } from "@tentickle/server";

// Set SSE headers on response
setSSEHeaders(res);

// Create SSE writer
const writer = createSSEWriter(res);

// Write events
writer.writeEvent({ type: "content_delta", delta: "Hello" });
writer.writeComment("keepalive");
writer.writeError({ code: "SESSION_NOT_FOUND", message: "Not found" });

// Close when done
writer.close();
```

### SSE Writer Interface

```typescript
interface SSEWriter {
  writeEvent(event: unknown): void;
  writeComment(comment: string): void;
  writeError(error: { type?: string; code?: string; message: string }): void;
  close(): void;
}
```

### Type Re-exports

Re-exports from `@tentickle/shared` for convenience:

```typescript
export type {
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,
} from "@tentickle/shared";
```

## File Structure

```
packages/server/src/
├── index.ts    # Public exports
├── types.ts    # Type re-exports from shared
└── sse.ts      # SSE utilities
```

## Usage

### With Express

```typescript
import { setSSEHeaders, createSSEWriter } from "@tentickle/server";

app.get("/events", (req, res) => {
  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  // Write events
  writer.writeEvent({ type: "connected", connectionId: "123" });

  // Keepalive
  const keepalive = setInterval(() => {
    writer.writeComment("keepalive");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
    writer.close();
  });
});
```

### Streaming Events

```typescript
import { setSSEHeaders, createSSEWriter } from "@tentickle/server";

app.post("/send", async (req, res) => {
  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  const session = app.getOrCreateSession(req.body.sessionId);
  const handle = session.send(req.body);

  for await (const event of handle) {
    writer.writeEvent({ ...event, sessionId: req.body.sessionId });
  }

  const result = await handle;
  writer.writeEvent({ type: "result", result });
  writer.close();
});
```

## Why This Package Exists

Framework adapters (`@tentickle/express`, `@tentickle/nestjs`, etc.) need shared utilities:

1. **SSE helpers** - Consistent SSE formatting across adapters
2. **Type re-exports** - Convenient imports for adapter authors
3. **Error codes** - Standardized error responses

This package keeps the shared utilities in one place without duplicating code.

## What This Package Doesn't Do

- **Session management** - Use `@tentickle/core` (`App`, `Session`)
- **Routing** - Use framework adapters (`@tentickle/express`, etc.)
- **Authentication** - Handle in your framework middleware
- **Connection tracking** - Handled by framework adapters
