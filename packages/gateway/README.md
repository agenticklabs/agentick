# @tentickle/gateway

Standalone daemon for multi-client, multi-agent access.

## The Problem

The embedded server approach (`@tentickle/express`) works for:

- Web apps with their own backend
- Single-user applications
- Request-response patterns

But it doesn't work for:

- CLI connecting to a running agent
- Multiple clients (phone, laptop, web) to the same agent
- Always-on agents with persistent state
- Multi-agent coordination
- External messaging channels (WhatsApp, Slack)

## The Solution

**Gateway** is a standalone daemon that:

1. Hosts multiple agents
2. Manages persistent sessions
3. Exposes a WebSocket API for clients
4. Routes messages to the right agent/session
5. Connects to external channels

## Installation

```bash
npm install @tentickle/gateway
# or
pnpm add @tentickle/gateway
```

## Quick Start

```typescript
import { createGateway } from '@tentickle/gateway';
import { createApp, Model, System, Timeline } from '@tentickle/core';

// Define agents
const ChatAgent = () => (
  <>
    <Model model={gpt4} />
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
);

const ResearchAgent = () => (
  <>
    <Model model={claude} />
    <System>You are a research specialist.</System>
    <Tool name="web_search" />
    <Timeline />
  </>
);

// Create gateway
const gateway = createGateway({
  port: 18789,
  host: '127.0.0.1',

  agents: {
    chat: createApp(ChatAgent),
    research: createApp(ResearchAgent),
  },
  defaultAgent: 'chat',

  auth: {
    type: 'token',
    token: process.env.GATEWAY_TOKEN,
  },
});

await gateway.start();
console.log('Gateway running on ws://127.0.0.1:18789');
```

## Architecture

```
┌─────────────────────────────────────────────┐
│                  GATEWAY                     │
│            (daemon process)                  │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │           WebSocket Server               │ │
│  │         (ws://127.0.0.1:18789)          │ │
│  └───────────────────┬─────────────────────┘ │
│                      │                       │
│         ┌────────────┼────────────┐         │
│         │            │            │         │
│         ▼            ▼            ▼         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │  CLI     │ │  Web UI  │ │  Mobile  │    │
│  │  Client  │ │  Client  │ │  Client  │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│                                              │
├──────────────────────────────────────────────┤
│                                              │
│   ┌─────────────────────────────────────┐   │
│   │           Agent Registry             │   │
│   ├──────────┬──────────┬───────────────┤   │
│   │  Agent1  │  Agent2  │    Agent3     │   │
│   │  (chat)  │(research)│    (coder)    │   │
│   └────┬─────┴────┬─────┴───────┬───────┘   │
│        │          │             │           │
│   ┌────┴──────────┴─────────────┴────┐      │
│   │         Session Manager          │      │
│   │   ┌─────┐ ┌─────┐ ┌─────┐       │      │
│   │   │sess1│ │sess2│ │sess3│  ...  │      │
│   │   └─────┘ └─────┘ └─────┘       │      │
│   └──────────────────────────────────┘      │
│                                              │
└─────────────────────────────────────────────┘
```

## Connecting Clients

### Using @tentickle/cli

```bash
tentickle chat --url ws://127.0.0.1:18789 --token $TOKEN
```

### Using @tentickle/client

```typescript
import { createClient } from '@tentickle/client';

// Client auto-detects WebSocket for ws:// URLs
const client = createClient({
  baseUrl: 'ws://127.0.0.1:18789',
  token: process.env.GATEWAY_TOKEN,
});

// Get session (routes to default agent)
const session = client.session('main');

// Send message
const handle = session.send('Hello!');
for await (const event of handle) {
  console.log(event);
}

// Or specify agent
const researchSession = client.session('research:task-1');
await researchSession.send('Research competitors');
```

## Configuration

### Full Options

```typescript
createGateway({
  // Server
  port: 18789,              // Default: 18789
  host: '127.0.0.1',        // Default: 127.0.0.1
  id: 'my-gateway',         // Auto-generated if not provided

  // Agents
  agents: {
    chat: createApp(ChatAgent),
    research: createApp(ResearchAgent),
  },
  defaultAgent: 'chat',

  // Authentication
  auth: {
    type: 'token',
    token: 'secret',
  },
  // Or: { type: 'none' }
  // Or: { type: 'jwt', secret: 'xxx' }
  // Or: { type: 'custom', validate: async (token) => ({ valid: true }) }

  // Persistence (coming soon)
  storage: {
    directory: '~/.tentickle',
    sessions: true,
    memory: true,
  },

  // Channels (coming soon)
  channels: [
    whatsapp({ ... }),
    slack({ ... }),
  ],

  // Routing
  routing: {
    channels: {
      whatsapp: 'chat',
      slack: 'coder',
    },
    custom: (message, context) => {
      if (message.text.includes('research')) return 'research';
      return null; // Use default
    },
  },
});
```

## Protocol

### Connection

```typescript
// Client → Gateway
{ type: 'connect', clientId: 'cli-abc123', token: 'xxx' }

// Gateway → Client
{ type: 'connected', gatewayId: 'gw-xyz', agents: ['chat', 'research'], sessions: [] }
```

### Request/Response

```typescript
// Client → Gateway
{ type: 'req', id: 'req-001', method: 'send', params: { sessionId: 'main', message: 'Hello!' } }

// Gateway → Client
{ type: 'res', id: 'req-001', ok: true, payload: { messageId: 'msg-123' } }
```

### Streaming Events

```typescript
// Gateway → Client (subscribed sessions)
{ type: 'event', event: 'content_delta', sessionId: 'main', data: { delta: 'Hello' } }
{ type: 'event', event: 'tool_call_start', sessionId: 'main', data: { name: 'search' } }
{ type: 'event', event: 'message_end', sessionId: 'main', data: {} }
```

## RPC Methods

| Method        | Description                 |
| ------------- | --------------------------- |
| `send`        | Send message to session     |
| `abort`       | Abort current execution     |
| `status`      | Get gateway/session status  |
| `history`     | Get conversation history    |
| `reset`       | Reset a session             |
| `close`       | Close a session             |
| `agents`      | List available agents       |
| `sessions`    | List sessions               |
| `subscribe`   | Subscribe to session events |
| `unsubscribe` | Unsubscribe from events     |

## Session Keys

Session keys follow the format `[agent:]name`:

```
main                  # Default agent, "main" session
chat:main             # "chat" agent, "main" session
research:task-123     # "research" agent, "task-123" session
whatsapp:+1234567890  # Channel session
```

## Events

```typescript
gateway.on('started', ({ port, host }) => {});
gateway.on('stopped', () => {});
gateway.on('client:connected', ({ clientId }) => {});
gateway.on('client:disconnected', ({ clientId, reason }) => {});
gateway.on('session:created', ({ sessionId, agentId }) => {});
gateway.on('session:closed', ({ sessionId }) => {});
gateway.on('session:message', ({ sessionId, role, content }) => {});
gateway.on('error', (error) => {});
```

## Comparison: Server vs Gateway

| Feature    | `@tentickle/server`  | `@tentickle/gateway`  |
| ---------- | -------------------- | --------------------- |
| Deployment | Embedded in your app | Standalone daemon     |
| Transport  | SSE                  | WebSocket             |
| Agents     | Single               | Multiple              |
| Sessions   | Ephemeral            | Persistent            |
| Clients    | Web browsers         | CLI, mobile, web      |
| Channels   | None                 | WhatsApp, Slack, etc. |
| State      | In-memory            | File-based            |
| Use case   | Web apps             | Personal assistants   |

## Development

```bash
# Clone the repo
git clone https://github.com/your-org/tentickle.git
cd tentickle

# Install dependencies
pnpm install

# Build
cd packages/gateway
pnpm build

# Run tests
pnpm test
```

## Roadmap

- [x] Core gateway with WebSocket
- [x] Agent registry
- [x] Session manager
- [ ] File-based persistence
- [ ] Channel adapters (WhatsApp, Slack)
- [ ] Multi-agent communication
- [ ] Tailscale integration
- [ ] Health checks and metrics

## Related Packages

- [`@tentickle/core`](../core) - JSX runtime for agents
- [`@tentickle/client`](../client) - Client SDK
- [`@tentickle/cli`](../cli) - Terminal client
- [`@tentickle/server`](../server) - Embeddable SSE server
- [`@tentickle/express`](../express) - Express middleware

## License

MIT
