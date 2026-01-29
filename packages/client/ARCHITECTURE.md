# @tentickle/client Architecture

Browser/Node.js client for connecting to Tentickle servers.

## Wire Protocol

> **All wire protocol types come from `@tentickle/shared`.**
>
> See [`@tentickle/shared/ARCHITECTURE.md`](../shared/ARCHITECTURE.md) for the protocol specification.

```typescript
// Protocol types - ALWAYS from shared, never duplicated
import type { ChannelEvent, SessionResultPayload } from "@tentickle/shared";
import { FrameworkChannels } from "@tentickle/shared";
```

## Overview

The client package provides a browser/Node.js SDK for connecting to Tentickle servers. It implements a single multiplexed connection that carries multiple logical channels.

```
┌─────────────────────────────────────────────────────────────────┐
│                     TentickleClient                             │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ Framework Sugar │  │ Channel Access  │  │  Session Mgmt   │  │
│  │ send()          │  │ channel(name)   │  │ createSession() │  │
│  │ tick()          │  │ subscribe()     │  │ connect()       │  │
│  │ abort()         │  │ publish()       │  │ disconnect()    │  │
│  │ onEvent()       │  │ request()       │  │ getState()      │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │           │
│           └────────────────────┼────────────────────┘           │
│                                │                                │
│                    ┌───────────▼───────────┐                    │
│                    │      Transport        │                    │
│                    │  (pluggable)          │                    │
│                    └───────────┬───────────┘                    │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                ┌────────────────┴────────────────┐
                │                                 │
          ┌─────▼─────┐                    ┌──────▼──────┐
          │   HTTP    │                    │  WebSocket  │
          │   /SSE    │                    │  (optional) │
          │ (default) │                    │             │
          └───────────┘                    └─────────────┘
```

## Key Components

### TentickleClient

The main client class that applications interact with.

**Responsibilities:**
- Session lifecycle (createSession, connect, disconnect)
- Framework channel sugar (send, tick, abort, onEvent, onResult)
- Generic channel access (channel accessor factory)
- Event routing (incoming events to correct handlers)

### Transport Interface

Pluggable transport abstraction:

```typescript
interface Transport {
  readonly name: string;
  readonly state: ConnectionState;

  connect(sessionId: string, metadata?: ConnectionMetadata): Promise<void>;
  disconnect(): Promise<void>;
  send(event: ChannelEvent): Promise<void>;

  onReceive(handler: (event: ChannelEvent) => void): () => void;
  onStateChange(handler: (state: ConnectionState) => void): () => void;
}
```

### HTTPTransport (Default)

```
Client → Server: HTTP POST to configurable path (default: /events)
Server → Client: SSE stream from configurable path (default: /events)
```

### WebSocketTransport (Alternative)

```
Bidirectional WebSocket connection
Use when SSE is unavailable or lower latency needed
```

## Escape Hatches

The client provides multiple levels of customization:

### 1. Custom Headers (Any Auth Scheme)

Add custom headers without replacing the transport:

```typescript
// API key auth
const client = createClient({
  baseUrl: "https://api.example.com",
  headers: { "X-API-Key": "my-api-key" },
});

// Basic auth
const client = createClient({
  baseUrl: "https://api.example.com",
  headers: { Authorization: "Basic " + btoa("user:pass") },
});

// Bearer token (convenience - equivalent to headers: { Authorization: "Bearer ..." })
const client = createClient({
  baseUrl: "https://api.example.com",
  token: "my-jwt-token",
});
```

### 2. Custom fetch/EventSource (HTTP Transport)

Replace the underlying network primitives:

```typescript
// Custom fetch with credentials
const client = createClient({
  baseUrl: "https://api.example.com",
  fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
});

// Node.js with polyfills
import EventSource from "eventsource";

const nodeClient = createClient({
  baseUrl: "https://api.example.com",
  EventSource,
});
```

### 3. Custom WebSocket (WebSocket Transport)

```typescript
// Node.js with ws package
import WebSocket from "ws";
import { createClient, createWebSocketTransport } from "@tentickle/client";

const transport = createWebSocketTransport({
  baseUrl: "wss://api.example.com",
  WebSocket: WebSocket as any,
});

const client = createClient({ baseUrl: "wss://api.example.com" }, transport);
```

### 4. Fully Custom Transport

Implement the `Transport` interface for complete control:

```typescript
import type { Transport, ChannelEvent } from "@tentickle/client";

class MyCustomTransport implements Transport {
  readonly name = "custom";
  state: ConnectionState = "disconnected";

  async connect(sessionId: string) { /* ... */ }
  async disconnect() { /* ... */ }
  async send(event: ChannelEvent) { /* ... */ }
  onReceive(handler: (event: ChannelEvent) => void) { /* ... */ }
  onStateChange(handler: (state: ConnectionState) => void) { /* ... */ }
}

const client = createClient(config, new MyCustomTransport());
```

## Configuration

All URLs are configurable with sensible defaults:

```typescript
const client = createClient({
  baseUrl: "https://api.example.com",

  // Optional path overrides (defaults shown)
  paths: {
    events: "/events",      // SSE + POST endpoint
    sessions: "/sessions",  // Session management
  },

  token: "auth-token",
  userId: "user_123",
  timeout: 30000,
  reconnectDelay: 1000,
  maxReconnectAttempts: 10,
});
```

## Data Flow

### Outgoing (Client → Server)

```
1. Application calls client.send('hello')
2. TentickleClient creates ChannelEvent for session:messages
3. Transport.send(channelEvent)
4. Network transmission (HTTP POST or WebSocket message)
```

### Incoming (Server → Client)

```
1. Network reception (SSE event or WebSocket message)
2. Transport calls receive handler
3. TentickleClient.handleIncomingEvent(event)
4. Route based on channel name:
   - FrameworkChannels.EVENTS → eventHandlers
   - FrameworkChannels.RESULT → resultHandlers
   - FrameworkChannels.TOOL_CONFIRMATION → toolConfirmationHandler
   - Other → channels.get(name)._handleEvent()
5. Handler callbacks invoked
```

## Connection States

```
                    ┌──────────────┐
                    │ disconnected │◄──────────────────┐
                    └──────┬───────┘                   │
                           │ connect()                 │
                           ▼                           │
                    ┌──────────────┐                   │
                    │  connecting  │                   │
                    └──────┬───────┘                   │
                           │ success                   │ max retries / error
                           ▼                           │
                    ┌──────────────┐                   │
              ┌────►│  connected   │                   │
              │     └──────┬───────┘                   │
              │            │ connection lost           │
              │            ▼                           │
              │     ┌──────────────┐                   │
              │     │    error     ├───────────────────┘
              │     └──────┬───────┘
              │            │ reconnect success
              └────────────┘
```

## File Structure

```
packages/client/src/
├── index.ts           # Public exports
├── client.ts          # TentickleClient class
├── types.ts           # Client types (re-exports protocol from shared)
└── transports/
    ├── index.ts       # Transport exports
    ├── http.ts        # HTTP/SSE transport (default)
    └── websocket.ts   # WebSocket transport (alternative)
```

## Usage

```typescript
import { createClient } from "@tentickle/client";

const client = createClient({ baseUrl: "https://api.example.com" });

// Create session on server
const { sessionId } = await client.createSession();

// Connect to session
await client.connect(sessionId);

// Framework channels
client.send("Hello!");
client.onEvent((event) => console.log(event));
client.tick();

// Application channels
const todos = client.channel("todos");
todos.subscribe((payload) => console.log(payload));
await todos.publish("add", { title: "Buy milk" });
```
