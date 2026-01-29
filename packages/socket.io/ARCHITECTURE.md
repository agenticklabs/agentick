# @tentickle/socket.io Architecture

Thin wrappers that let Socket.IO be Socket.IO.

## Philosophy

Socket.IO already handles:
- Connection management
- Reconnection
- Authentication (middleware)
- Rooms (sessions)
- Binary data
- Fallback transports

We don't reimplement any of that. We just:
1. Standardize two event names
2. Translate to/from `ChannelEvent`

That's it.

## The Contract

```typescript
// Two events. That's the entire protocol.
const CHANNEL_EVENT = "tentickle:event";  // ChannelEvent in both directions
const JOIN_SESSION = "tentickle:join";    // Client joins a session room
```

## Client

You create and configure the Socket.IO client. We wrap it.

```typescript
import { io } from 'socket.io-client';
import { createClient } from '@tentickle/client';
import { createSocketIOTransport } from '@tentickle/socket.io/client';

// Your socket, your config
const socket = io('https://api.example.com', {
  auth: { token: 'my-jwt' },
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
});

// We just wrap it
const transport = createSocketIOTransport({ socket });
const client = createClient({ baseUrl: 'https://api.example.com' }, transport);
```

The transport is ~60 lines. It:
- Maps Socket.IO connection events to `ConnectionState`
- Forwards `ChannelEvent` in both directions
- Emits `JOIN_SESSION` on connect

## Server

You create and configure the Socket.IO server. We wire up the events.

```typescript
import { Server } from 'socket.io';
import { createEventBridge, createSessionHandler } from '@tentickle/server';
import { createSocketIOAdapter } from '@tentickle/socket.io/server';

const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// Your auth - Socket.IO middleware
io.use(async (socket, next) => {
  try {
    const user = await verifyToken(socket.handshake.auth.token);
    socket.data.userId = user.id;
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
});

// Wire up Tentickle
const sessionHandler = createSessionHandler({ app: myApp });

// Create adapter first
const adapter = createSocketIOAdapter({
  io,
  onEvent: (connection, event) => {
    // Pass connection directly - no ID lookup needed
    eventBridge.handleEvent(connection, event);
  },
});

// EventBridge delegates to adapter - no duplicate connection tracking
const eventBridge = createEventBridge({
  sessionHandler,
  transport: adapter,
});
```

The adapter is ~70 lines. It:
- Listens for `JOIN_SESSION`, joins the socket to a room
- Forwards `ChannelEvent` to your handler with the connection object
- Broadcasts to rooms via `sendToSession`
- Tracks connected sockets for cleanup on `destroy()`

**No duplicate tracking:** When you pass `transport: adapter` to EventBridge, it delegates connection management entirely to the adapter. Socket.IO rooms handle session grouping.

### Cleanup

Call `adapter.destroy()` to clean up resources:

```typescript
// Removes connection listener from io
// Disconnects all tracked sockets
adapter.destroy();
```

This is called automatically when `EventBridge.destroy()` is called (if the adapter was passed to the bridge).

## Why This Design

**Bad:** Reimplementing Socket.IO features in a wrapper.

**Good:** Using Socket.IO features directly, only adding the thin translation layer needed for Tentickle's protocol.

The user keeps full control:
- Socket.IO configuration
- Authentication middleware
- Reconnection strategy
- Transport selection
- Error handling

We just standardize the event names and payload shape.

## File Structure

```
packages/socket.io/src/
├── index.ts    # Exports
├── types.ts    # Event names, minimal config types
├── client.ts   # ~60 lines
└── server.ts   # ~50 lines
```

Total: ~200 lines including types and docs.
