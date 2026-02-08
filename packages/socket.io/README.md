# @agentick/socket.io

Socket.IO transport adapter for Agentick. Thin wrappers that let Socket.IO be Socket.IO.

## Philosophy

You configure Socket.IO however you want (auth, transports, namespaces). This package just adapts it to Agentick's transport interfaces. No custom features, no reimplementation—just adapters.

## Installation

```bash
pnpm add @agentick/socket.io socket.io socket.io-client
```

## Client Usage

```typescript
import { io } from "socket.io-client";
import { createClient } from "@agentick/client";
import { createSocketIOTransport } from "@agentick/socket.io";

// Create your Socket.IO client (configure as needed)
const socket = io("http://localhost:3000", {
  auth: { token: "your-auth-token" },
});

// Wrap with Agentick transport
const transport = createSocketIOTransport({ socket });

// Use with Agentick client
const client = createClient({ transport });
const session = client.session("my-session");

for await (const event of session.send("Hello!")) {
  console.log(event);
}
```

## Server Usage

```typescript
import { Server } from "socket.io";
import { createGateway } from "@agentick/gateway";
import { createSocketIOAdapter } from "@agentick/socket.io";

// Create your Socket.IO server (configure as needed)
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// Add your auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (isValidToken(token)) {
    socket.data.userId = getUserIdFromToken(token);
    next();
  } else {
    next(new Error("Unauthorized"));
  }
});

// Create Agentick adapter
const adapter = createSocketIOAdapter({ io });

// Wire to gateway
const gateway = createGateway({
  agents: { assistant: myApp },
  transport: adapter,
});
```

## API

### Client

#### createSocketIOTransport(config)

Creates a `Transport` for use with `@agentick/client`.

```typescript
interface SocketIOClientConfig {
  socket: Socket; // Socket.IO client socket
}
```

**Transport Methods:**

| Method                   | Description                     |
| ------------------------ | ------------------------------- |
| `connect(sessionId)`     | Join a session room             |
| `disconnect()`           | Leave the session               |
| `send(event)`            | Send event to server            |
| `onReceive(handler)`     | Handle incoming events          |
| `onStateChange(handler)` | Handle connection state changes |

### Server

#### createSocketIOAdapter(config)

Creates a `ServerTransportAdapter` for the gateway.

```typescript
interface SocketIOServerConfig {
  io: Server | Namespace; // Socket.IO server or namespace
  onEvent?: (connection: ServerConnection, event: ChannelEvent) => void;
}
```

**Adapter Methods:**

| Method                            | Description               |
| --------------------------------- | ------------------------- |
| `sendToSession(sessionId, event)` | Broadcast to session room |
| `destroy()`                       | Clean up all connections  |

## Constants

```typescript
import { CHANNEL_EVENT, JOIN_SESSION } from "@agentick/socket.io";

CHANNEL_EVENT; // "agentick:event" - bidirectional channel events
JOIN_SESSION; // "agentick:join" - join a session room
```

## Session Rooms

The adapter uses Socket.IO rooms for session multiplexing:

- When a client calls `transport.connect(sessionId)`, it joins room `session:${sessionId}`
- `sendToSession(sessionId, event)` broadcasts to all sockets in that room
- Disconnection is handled automatically by Socket.IO

## With Namespaces

Use a namespace for isolation:

```typescript
const agentickNamespace = io.of("/agentick");

agentickNamespace.use(authMiddleware);

const adapter = createSocketIOAdapter({ io: agentickNamespace });
```

## Related Packages

- `@agentick/client` - Client library
- `@agentick/gateway` - Server gateway
- `@agentick/server` - Server utilities

## License

MIT
