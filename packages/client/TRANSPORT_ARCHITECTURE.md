# Tentickle Transport Architecture

A comprehensive guide to how client-server communication works in Tentickle.

## The Foundation: Shared Protocol

Package: `@tentickle/shared`  
Key file: `packages/shared/src/protocol.ts`

Everything flows through one type:

```
interface ChannelEvent<T = unknown> {
  channel: string;      // Which logical channel (e.g., "session:events")
  type: string;         // Event type within channel (e.g., "message", "tick")
  payload: T;           // The actual data
  id?: string;          // For request/response correlation
  metadata?: {          // Routing information
    sessionId?: string;
    userId?: string;
    timestamp?: number;
  };
}
```

Framework channels are predefined:

```
const FrameworkChannels = {
  MESSAGES: "session:messages",           // Client -> Server: user messages
  EVENTS: "session:events",               // Server -> Client: stream events
  CONTROL: "session:control",             // Client -> Server: tick, abort
  RESULT: "session:result",               // Server -> Client: final result
  TOOL_CONFIRMATION: "session:tool_confirmation",  // Bidirectional
};
```

Why this matters: every transport (HTTP, WebSocket, Socket.IO) speaks the same
language. The transport is just the pipe; `ChannelEvent` is what flows through it.

## Client Side

Package: `@tentickle/client`

### The Transport Interface

File: `packages/client/src/types.ts`

```
interface Transport {
  readonly name: string;
  readonly state: ConnectionState;  // "disconnected" | "connecting" | "connected" | "error"

  connect(sessionId: string, metadata?: ConnectionMetadata): Promise<void>;
  disconnect(): Promise<void>;
  send(event: ChannelEvent): Promise<void>;

  onReceive(handler: (event: ChannelEvent) => void): () => void;
  onStateChange(handler: (state: ConnectionState) => void): () => void;
}
```

This is the contract. Any transport must implement this.

### HTTP Transport (Default)

File: `packages/client/src/transports/http.ts`

```
┌─────────────────────────────────────────────────────────┐
│                    HTTPTransport                         │
│                                                         │
│   Client -> Server:  HTTP POST to /events               │
│   Server -> Client:  SSE stream from /events            │
│                                                         │
│   ┌─────────────┐         ┌─────────────────────────┐   │
│   │   send()    │-------->|  POST /events           │   │
│   │             │         │  Body: ChannelEvent     │   │
│   └─────────────┘         └─────────────────────────┘   │
│                                                         │
│   ┌─────────────┐         ┌─────────────────────────┐   │
│   │ onReceive() |<--------|  GET /events (SSE)      │   │
│   │             │         │  data: ChannelEvent     │   │
│   └─────────────┘         └─────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

Key implementation details:

- Connection: opens an `EventSource` to `/events?sessionId=...` (token via query param is optional)
- Sending: HTTP POST with `ChannelEvent` as JSON body
- Receiving: `EventSource` message event, parsed as `ChannelEvent`
- Reconnection: manual reconnection handles HTTP errors (EventSource only
  auto-reconnects on network failures)

Escape hatches:

- `headers`: custom auth headers
- `fetch`: custom fetch implementation
- `EventSource`: custom EventSource (for Node.js polyfills)
- `withCredentials`: send cookies with SSE + POST
- `authTokenInQuery`: opt-in token in SSE query params

### TentickleClient

File: `packages/client/src/client.ts`

The client wraps a transport and provides sugar methods:

```
class TentickleClient {
  private transport: Transport;

  // Session lifecycle
  async createSession(): Promise<{ sessionId: string }>;
  async connect(sessionId: string): Promise<void>;
  async disconnect(): Promise<void>;

  // Framework channel sugar
  send(content: string): void;           // -> session:messages
  tick(props?: object): void;            // -> session:control type="tick"
  abort(reason?: string): void;          // -> session:control type="abort"
  onEvent(handler): () => void;          // <- session:events
  onResult(handler): () => void;         // <- session:result

  // Generic channel access
  channel(name: string): ChannelAccessor;
}
```

Data flow for `client.send("Hello")`:

```
client.send("Hello")
   |
   v
Creates ChannelEvent {
  channel: "session:messages",
  type: "message",
  payload: { role: "user", content: [...] }
}
   |
   v
transport.send(event)
   |
   v
HTTP POST to /events (or WebSocket message, or Socket.IO emit)
```

## Server Side

Package: `@tentickle/server`

### The Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Web Framework                       │
│                       (Express, Fastify, etc.)                  │
│                                                                 │
│   Routes call into these handlers:                              │
│                                                                 │
│   POST /sessions ------> sessionHandler.create()                │
│   GET  /sessions/:id --> sessionHandler.getState()              │
│   GET  /events --------> eventBridge.registerConnection()       │
│   POST /events --------> eventBridge.handleEvent()              │
└───────────────────────────────┬─────────────────────────────────┘
                               |
┌───────────────────────────────v─────────────────────────────────┐
│                        EventBridge                               │
│                                                                 │
│   Routes ChannelEvents to the right handler:                    │
│                                                                 │
│   session:messages -----> session.send() (starts execution)     │
│   session:control ------> tick() or abort() (optional)          │
│   session:tool_confirmation -> session.channel().publish()      │
│                                                                 │
│   Broadcasts back to clients:                                   │
│                                                                 │
│   streamHandle() --> session:events to all connections          │
└───────────────────────────────┬─────────────────────────────────┘
                               |
┌───────────────────────────────v─────────────────────────────────┐
│                      SessionHandler                              │
│                                                                 │
│   Manages Tentickle sessions:                                   │
│                                                                 │
│   create() --> new Session                                      │
│   send()   --> session.send()                                   │
│   queueMessage() --> queued for next tick (no execution)        │
│   stream() --> async iterate session events                     │
└─────────────────────────────────────────────────────────────────┘
```

### EventBridge: Two Modes

File: `packages/server/src/event-bridge.ts`

EventBridge operates in two modes:

Mode 1: HTTP/SSE (no transport adapter)

EventBridge manages connections internally.

```
const bridge = createEventBridge({ sessionHandler });

// SSE endpoint - register connection
app.get('/events', (req, res) => {
  const connection: ServerConnection = {
    id: crypto.randomUUID(),
    sessionId: req.query.sessionId,
    send: async (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    close: () => res.end(),
  };
  bridge.registerConnection(connection);  // Bridge tracks it
});

// POST endpoint - handle event by ID lookup
app.post('/events', (req, res) => {
  await bridge.handleEvent(req.body.connectionId, req.body);  // Looks up connection
});
```

Mode 2: Socket.IO (with transport adapter)

EventBridge delegates connection management to the adapter.

```
const adapter = createSocketIOAdapter({
  io,
  onEvent: (connection, event) => {
    bridge.handleEvent(connection, event);  // Pass connection directly
  },
});

const bridge = createEventBridge({
  sessionHandler,
  transport: adapter,  // Adapter handles connections
});
// No registerConnection() calls needed
```

Delegation logic:

```
private get managesConnections(): boolean {
  return !this.transport;  // Only track if no adapter
}

private async sendToSession(sessionId, event) {
  if (this.transport) {
    await this.transport.sendToSession(sessionId, event);  // Delegate
    return;
  }
  // Otherwise use internal tracking...
}
```

### ServerConnection Interface

File: `packages/server/src/types.ts`

```
interface ServerConnection {
  readonly id: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly metadata: Record<string, unknown>;
  send(event: ChannelEvent): Promise<void>;  // How to send to this client
  close(): void;                              // How to disconnect
}
```

This is what your framework creates. For SSE, `send` writes to the response
stream. For Socket.IO, `send` emits an event.

### ServerTransportAdapter Interface

File: `packages/server/src/types.ts`

```
interface ServerTransportAdapter {
  readonly name: string;
  sendToSession(sessionId: string, event: ChannelEvent): Promise<void>;
  destroy(): void;
}
```

Adapters that manage their own connections (like Socket.IO with rooms)
implement this.

## Socket.IO Package

Package: `@tentickle/socket.io`

Philosophy:

- Connection management
- Reconnection
- Authentication (middleware)
- Rooms (perfect for sessions)

We do not reimplement. We just standardize two event names:

```
const CHANNEL_EVENT = "tentickle:event";  // ChannelEvent in both directions
const JOIN_SESSION = "tentickle:join";    // Client joins a session room
```

### Client Transport

File: `packages/socket.io/src/client.ts`

```
function createSocketIOTransport(config: { socket: ClientSocket }): Transport {
  const { socket } = config;  // You create and configure the socket

  return {
    name: "socket.io",

    get state() { /* map socket.connected to ConnectionState */ },

    async connect(sessionId, metadata) {
      if (!socket.connected) socket.connect();
      socket.emit(JOIN_SESSION, { sessionId, metadata });
    },

    async send(event) {
      socket.emit(CHANNEL_EVENT, event);
    },

    onReceive(handler) {
      socket.on(CHANNEL_EVENT, handler);
      return () => socket.off(CHANNEL_EVENT, handler);
    },
    // ...
  };
}
```

The rest is types and docs.

### Server Adapter

File: `packages/socket.io/src/server.ts`

```
function createSocketIOAdapter(config: {
  io: Server | Namespace;
  onEvent?: (connection: ServerConnection, event: ChannelEvent) => void;
}): ServerTransportAdapter {
  const { io, onEvent } = config;

  io.on("connection", (socket) => {
    socket.on(JOIN_SESSION, async (payload) => {
      await socket.join(`session:${payload.sessionId}`);  // Socket.IO room

      const connection: ServerConnection = {
        id: socket.id,
        sessionId: payload.sessionId,
        send: async (event) => socket.emit(CHANNEL_EVENT, event),
        close: () => socket.disconnect(true),
      };
      socket.data.connection = connection;
    });

    socket.on(CHANNEL_EVENT, (event) => {
      onEvent?.(socket.data.connection, event);
    });
  });

  return {
    name: "socket.io",
    async sendToSession(sessionId, event) {
      io.to(`session:${sessionId}`).emit(CHANNEL_EVENT, event);  // Room broadcast
    },
    destroy() { /* Socket.IO lifecycle is yours */ },
  };
}
```

Socket.IO rooms handle session grouping natively.

## Complete Data Flow Examples

Example 1: HTTP/SSE - user sends a message

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CLIENT                                                                    │
│                                                                          │
│ client.send("Hello")                                                     │
│     │                                                                    │
│     v                                                                    │
│ HTTPTransport.send({                                                     │
│   channel: "session:messages",                                           │
│   type: "message",                                                       │
│   payload: { role: "user", content: [{ type: "text", text: "Hello" }] }  │
│ })                                                                       │
│     │                                                                    │
│     v                                                                    │
│ HTTP POST /events ----------------------------------------------------->│
└──────────────────────────────────────────────────────────────────────────┘
                                                                           │
┌───────────────────────────────────────────────────────────────────────────v
│ SERVER                                                                    │
│                                                                          │
│ Express route: POST /events                                              │
│     │                                                                    │
│     v                                                                    │
│ eventBridge.handleEvent(connectionId, event)                             │
│     │                                                                    │
│     v                                                                    │
│ Looks up connection from internal Map                                    │
│     │                                                                    │
│     v                                                                    │
│ switch(event.channel) -> "session:messages"                              │
│     │                                                                    │
│     v                                                                    │
│ sessionHandler.send(sessionId, { messages: [message] })                  │
│     │                                                                    │
│     v                                                                    │
│ Session queues message, triggers tick if idle                            │
└──────────────────────────────────────────────────────────────────────────┘
```

Example 2: Socket.IO - server streams response

```
┌──────────────────────────────────────────────────────────────────────────┐
│ SERVER                                                                    │
│                                                                          │
│ Session generates StreamEvent { type: "content_delta", delta: "Hi" }     │
│     │                                                                    │
│     v                                                                    │
│ eventBridge.sendToSession(sessionId, {                                   │
│   channel: "session:events",                                             │
│   type: "content_delta",                                                 │
│   payload: event                                                         │
│ })                                                                       │
│     │                                                                    │
│     v                                                                    │
│ this.transport exists? YES -> delegate                                   │
│     │                                                                    │
│     v                                                                    │
│ adapter.sendToSession(sessionId, event)                                  │
│     │                                                                    │
│     v                                                                    │
│ io.to(`session:${sessionId}`).emit("tentickle:event", event)             │
│     │                                                                    │
└─────┼────────────────────────────────────────────────────────────────────┘
     │
     │ Socket.IO broadcasts to all sockets in the room
     │
┌─────v────────────────────────────────────────────────────────────────────┐
│ CLIENT                                                                    │
│                                                                          │
│ socket.on("tentickle:event", handler)                                    │
│     │                                                                    │
│     v                                                                    │
│ receiveHandlers.forEach(h => h(event))                                   │
│     │                                                                    │
│     v                                                                    │
│ TentickleClient routes by channel -> "session:events"                    │
│     │                                                                    │
│     v                                                                    │
│ eventHandlers.forEach(h => h(event.payload))                             │
│     │                                                                    │
│     v                                                                    │
│ Your app: onEvent((e) => console.log(e.delta)) -> "Hi"                    │
└──────────────────────────────────────────────────────────────────────────┘
```

## File Reference

```
┌──────────────────────┬────────────────────────┬───────────────────────────────────────────────────────┐
│       Package        │          File          │                        Purpose                        │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/shared    │ src/protocol.ts        │ ChannelEvent, FrameworkChannels, all protocol types   │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/client    │ src/types.ts           │ Transport interface, ClientConfig                     │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/client    │ src/client.ts          │ TentickleClient class                                 │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/client    │ src/transports/http.ts │ HTTPTransport implementation                          │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/server    │ src/types.ts           │ ServerConnection, EventBridge, ServerTransportAdapter │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/server    │ src/event-bridge.ts    │ EventBridgeImpl - routing and connection management   │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/server    │ src/session-handler.ts │ SessionHandler - session lifecycle                    │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/socket.io │ src/types.ts           │ Event names, minimal config types                     │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/socket.io │ src/client.ts          │ createSocketIOTransport                               │
├──────────────────────┼────────────────────────┼───────────────────────────────────────────────────────┤
│ @tentickle/socket.io │ src/server.ts          │ createSocketIOAdapter                                 │
└──────────────────────┴────────────────────────┴───────────────────────────────────────────────────────┘
```

## Verification Checklist

- Protocol types are shared: both client and server import from `@tentickle/shared`
- Transport is pluggable: `TentickleClient` accepts any `Transport` implementation
- EventBridge has two modes: check `managesConnections` and `sendToSession`
- Socket.IO is thin: implementation is mostly connection/room plumbing
- No duplicate tracking: when transport is set, `registerConnection` is a no-op
