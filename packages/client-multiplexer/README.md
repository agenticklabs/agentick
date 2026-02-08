# @agentick/client-multiplexer

Multi-tab connection multiplexer for Agentick client. Reduces server connections by sharing a single SSE connection across all browser tabs.

## Installation

```bash
npm install @agentick/client-multiplexer
# or
pnpm add @agentick/client-multiplexer
```

## Quick Start

```typescript
import { createClient } from '@agentick/client';
import { createSharedTransport } from '@agentick/client-multiplexer';

// Create client with shared transport
const client = createClient({
  baseUrl: '/api',
  transport: createSharedTransport({ baseUrl: '/api', token: 'your-token' }),
});

// Use exactly like a regular client
const session = client.session('main');
session.subscribe();
session.onEvent((event) => console.log(event));

const handle = session.send('Hello!');
await handle.result;
```

## How It Works

The multiplexer uses browser tab leader election to ensure only one tab maintains the actual server connection:

1. **Leader Election**: Uses Web Locks API (instant, reliable) with BroadcastChannel fallback for older browsers
2. **Connection Sharing**: Only the leader tab opens the SSE connection to the server
3. **Message Forwarding**: Follower tabs send requests via BroadcastChannel to the leader
4. **Event Broadcasting**: Leader broadcasts server events to all tabs
5. **Automatic Failover**: When leader tab closes, a new leader is elected and re-establishes subscriptions

## Features

- **Resource Efficient**: Single server connection regardless of tab count
- **Transparent**: Works with existing Agentick client code
- **Automatic Failover**: Seamless recovery when leader tab closes
- **Subscription Aggregation**: Leader maintains union of all tabs' subscriptions
- **Per-Tab Filtering**: Each tab only receives events for its own sessions

## API

### createSharedTransport(config)

Creates a shared transport instance. Supports both SSE and WebSocket transports.

```typescript
import { createSharedTransport, type SharedTransportConfig } from '@agentick/client-multiplexer';

// SSE transport (default for http:// URLs)
const sseTransport = createSharedTransport({
  baseUrl: 'https://api.example.com',
  token: 'your-auth-token',      // Optional
  timeout: 30000,                 // Optional
  withCredentials: true,          // Optional
});

// WebSocket transport (default for ws:// URLs)
const wsTransport = createSharedTransport({
  baseUrl: 'wss://api.example.com',
  token: 'your-auth-token',
  clientId: 'my-client',          // Optional
  reconnect: {                    // Optional
    enabled: true,
    maxAttempts: 5,
    delay: 1000,
  },
});

// Explicit transport selection
const explicitTransport = createSharedTransport({
  baseUrl: 'https://api.example.com',
  transport: 'websocket',         // Force WebSocket even with http:// URL
});
```

### SharedTransport

The transport implements `ClientTransport` from `@agentick/client` plus additional properties:

```typescript
// Check leadership status
transport.isLeader;  // boolean

// Get unique tab identifier
transport.tabId;     // string

// Listen for leadership changes
transport.onLeadershipChange((isLeader) => {
  console.log(isLeader ? 'This tab is now the leader' : 'Leadership transferred');
});
```

### Accessing Transport from Client

```typescript
import { createClient, type ClientTransport } from '@agentick/client';
import { createSharedTransport, type SharedTransport } from '@agentick/client-multiplexer';

const client = createClient({
  baseUrl: '/api',
  transport: createSharedTransport({ baseUrl: '/api' }),
});

// Access the transport for leadership info
const transport = client.getTransport() as SharedTransport | undefined;
console.log('Is leader:', transport?.isLeader);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser Tabs                                │
├──────────────────┬──────────────────┬──────────────────────────────┤
│     Tab 1        │     Tab 2        │     Tab 3                    │
│  (Leader)        │  (Follower)      │  (Follower)                  │
│                  │                  │                              │
│ SharedTransport  │ SharedTransport  │ SharedTransport              │
│      │           │      │           │      │                       │
│      │           │      │           │      │                       │
│  ┌───▼───┐       │  ┌───▼───┐       │  ┌───▼───┐                   │
│  │ SSE   │       │  │Bridge │       │  │Bridge │                   │
│  │ Conn  │       │  │  Only │       │  │  Only │                   │
│  └───┬───┘       │  └───┬───┘       │  └───┬───┘                   │
│      │           │      │           │      │                       │
└──────┼───────────┴──────┼───────────┴──────┼───────────────────────┘
       │                  │                  │
       │    ◄─────────────┴──────────────────┘
       │         BroadcastChannel
       │
       ▼
   ┌───────┐
   │Server │
   └───────┘
```

## Failover

When the leader tab closes:

1. Other tabs detect leadership vacancy (via Web Locks or heartbeat timeout)
2. New leader is elected (fastest tab to acquire lock)
3. New leader broadcasts `leader:ready` message
4. Follower tabs respond with their current subscriptions
5. New leader aggregates subscriptions and re-subscribes on the server
6. Events flow again to all tabs

## Browser Support

- **Web Locks API**: Chrome 69+, Firefox 96+, Safari 15.4+, Edge 79+
- **BroadcastChannel**: All modern browsers
- **Fallback**: Heartbeat-based election for browsers without Web Locks

## License

ISC
