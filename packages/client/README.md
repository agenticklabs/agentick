# @tentickle/client

Client SDK for connecting to Tentickle servers. Provides a single multiplexed connection with framework channel sugar and generic channel access.

## Installation

```bash
pnpm add @tentickle/client
# or
npm install @tentickle/client
```

## Quick Start

```typescript
import { createClient } from '@tentickle/client';

const client = createClient({
  url: 'wss://api.example.com',
  userId: 'user_123',
});

await client.connect();

// Send a message
client.send('Hello!');

// Listen for stream events
client.onEvent((event) => {
  if (event.type === 'content_delta') {
    process.stdout.write(event.delta);
  }
});
```

## API Reference

### `createClient(config)`

Creates a new TentickleClient instance.

```typescript
const client = createClient({
  // Required: Server URL (WebSocket or HTTP)
  url: 'wss://api.example.com',

  // Optional: User ID for room-based routing
  userId: 'user_123',

  // Optional: Session ID (can be created server-side)
  sessionId: 'session_456',

  // Optional: Authentication token
  token: 'bearer_token',

  // Optional: Transport type (auto-detected from URL)
  transport: 'websocket', // or 'sse'

  // Optional: Reconnection settings
  reconnectDelay: 1000,      // ms between attempts
  maxReconnectAttempts: 10,

  // Optional: Auto-connect on creation
  autoConnect: false,
});
```

### Connection Lifecycle

```typescript
// Connect to server
await client.connect();

// Current state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
console.log(client.state);

// Listen for state changes
const unsubscribe = client.onConnectionChange((state) => {
  console.log('Connection state:', state);
});

// Reconnect (disconnect then connect)
await client.reconnect();

// Disconnect
await client.disconnect();

// Cleanup all resources
client.destroy();
```

### Framework Channels

Framework channels provide sugar for common session operations. These map to well-known channel names that the server understands.

#### `client.send(input)`

Send messages to the session and start execution. Publishes to `session:messages`.

```typescript
// Send text
client.send('What is the weather?');

// Send content blocks
client.send([
  { type: 'text', text: 'Analyze this image:' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
]);

// Send a fully shaped message
client.send({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });

// Send messages with props/metadata (thin channel → session.send)
client.send({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Search docs' }] }],
  props: { mode: 'search' },
  metadata: { traceId: 'abc-123' },
});
```

#### `client.tick(options?)`

Trigger a tick (model execution cycle) without sending a message. Publishes to `session:control`.

```typescript
// Simple tick
client.tick();

// Tick with props
client.tick({
  props: {
    query: 'search for documents',
    context: { userId: 'user_123' },
  },
});
```

#### `client.abort(reason?)`

Abort the current execution. Publishes to `session:control`.

```typescript
client.abort();
client.abort('User cancelled');
```

#### `client.onEvent(handler)`

Subscribe to stream events from the session. Listens on `session:events`.

```typescript
const unsubscribe = client.on("event", (event) => {
  switch (event.type) {
    case 'content_delta':
      // Incremental text content
      process.stdout.write(event.delta);
      break;
    case 'result':
      // Final structured result
      console.log('Response:', event.result.response);
      console.log('Usage:', event.result.usage);
      break;
    case 'tool_call':
      // Tool is being called
      console.log('Tool:', event.name, event.arguments);
      break;
    case 'tool_result':
      // Tool returned result
      console.log('Result:', event.result);
      break;
    case 'tick_start':
      console.log('Tick', event.tick, 'started');
      break;
    case 'tick_end':
      console.log('Tick', event.tick, 'ended');
      break;
  }
});

// Later: unsubscribe
unsubscribe();
```

#### `client.on('message', handler)`

Subscribe to a specific stream event type (e.g. `message`, `tool_call`, `content_delta`).

```typescript
client.on("message", (event) => {
  console.log("Message:", event.message);
});
```

#### `client.on('result', handler)`

Subscribe to final execution results. Listens on `session:result`.

```typescript
client.on("result", (result) => {
  console.log('Response:', result.response);
  console.log('Usage:', result.usage);
});
```

#### `client.on('tool_confirmation', handler)`

Handle tool confirmation requests (for tools that require user approval).

```typescript
client.on("tool_confirmation", (request, respond) => {
  // Show confirmation UI
  const approved = confirm(`Allow ${request.name}?`);

  respond({
    approved,
    reason: approved ? undefined : 'User declined',
  });
});

#### Backwards-compatible handlers

The legacy helpers are still available:

- `client.onEvent(handler)`
- `client.onResult(handler)`
- `client.onToolConfirmation(handler)`

Note: `client.on("result", ...)` subscribes to the `session:result` channel.
If you want the stream event `{ type: "result" }`, use `client.on("event", ...)`
and filter by `event.type === "result"`.
```

### Application Channels

Application channels provide generic pub/sub for custom features. These are user-scoped (shared across sessions for the same user).

#### `client.channel(name)`

Get a channel accessor for pub/sub operations.

```typescript
const todoChannel = client.channel('todo_list');
```

#### `channel.subscribe(handler)`

Subscribe to events on the channel.

```typescript
const unsubscribe = todoChannel.subscribe((event) => {
  if (event.type === 'tasks_updated') {
    updateUI(event.payload.tasks);
  }
});

// Later: unsubscribe
unsubscribe();
```

#### `channel.publish(event)`

Publish an event to the channel.

```typescript
await todoChannel.publish({
  type: 'create_task',
  payload: { title: 'Buy milk', priority: 'high' },
});
```

#### `channel.request(event, timeoutMs?)`

Request/response pattern. Sends an event and waits for a response.

```typescript
const response = await todoChannel.request({
  type: 'get_tasks',
  payload: { filter: 'incomplete' },
});

console.log('Tasks:', response.payload.tasks);
```

## Transports

The client supports two transport types:

### SSE Transport (Server-Sent Events)

- Server → Client: SSE stream
- Client → Server: HTTP POST requests
- Best for: HTTP/2 environments, simpler server setup

```typescript
const client = createClient({
  url: 'https://api.example.com/channels',
  transport: 'sse', // explicit, or auto-detected from http(s):// URL
});
```

### WebSocket Transport

- Bidirectional WebSocket connection
- Best for: Low-latency, high-frequency messaging

```typescript
const client = createClient({
  url: 'wss://api.example.com',
  transport: 'websocket', // explicit, or auto-detected from ws(s):// URL
});
```

### Using Transports Directly

For advanced use cases, you can use transports directly:

```typescript
import { SSETransport, WebSocketTransport } from '@tentickle/client/transports';

const transport = new WebSocketTransport({
  url: 'wss://api.example.com',
  token: 'auth_token',
  reconnectDelay: 1000,
  maxReconnectAttempts: 10,
  autoJoinRooms: (metadata) => [
    `user:${metadata.userId}`,
    `tenant:${metadata.tenantId}`,
  ],
});

await transport.connect('connection_123', { userId: 'user_123' });

transport.onReceive((event) => {
  console.log('Received:', event);
});

await transport.send({
  channel: 'my_channel',
  type: 'my_event',
  payload: { data: 'hello' },
});
```

## Channel Architecture

The client uses a layered channel model:

```
┌─────────────────────────────────────────────────────────────────┐
│  Application Layer (user-scoped)                                │
│  └── Custom channels: todo_list, scratchpad, notifications      │
│  └── Shared across sessions for same user                       │
├─────────────────────────────────────────────────────────────────┤
│  Framework Layer (session-scoped)                               │
│  └── session:messages - conversation input                      │
│  └── session:events - stream output                             │
│  └── session:control - commands (abort, tick)                   │
│  └── session:result - final execution result                    │
│  └── session:tool_confirmation - tool approval flow             │
├─────────────────────────────────────────────────────────────────┤
│  Transport Layer                                                │
│  └── Single multiplexed connection (SSE or WebSocket)           │
│  └── All channels flow over ONE connection                      │
└─────────────────────────────────────────────────────────────────┘
```

### Multiplexing

All channels share a single connection:

```
                    ONE CONNECTION (SSE/WS)
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
session:events        todo_list           notifications
(framework)          (application)        (application)
session-scoped       user-scoped          user-scoped
```

## Transport Architecture

For a detailed walkthrough of HTTP/SSE, WebSocket, and Socket.IO transport
flows, see `packages/client/TRANSPORT_ARCHITECTURE.md`.

## TypeScript Types

```typescript
import type {
  // Client
  ClientConfig,
  ConnectionState,
  ChannelAccessor,
  SendResult,

  // Tool confirmation
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  ToolConfirmationCallback,

  // Channels
  ChannelEvent,
  ChannelTarget,

  // Transports
  Transport,
  TransportConfig,
  ConnectionMetadata,

  // Events (re-exported from @tentickle/shared)
  StreamEvent,
} from '@tentickle/client';
```

## Examples

### Chat Application

```typescript
import { createClient } from '@tentickle/client';

const client = createClient({
  url: 'wss://api.example.com',
  userId: currentUser.id,
});

await client.connect();

// Accumulate response content
let response = '';

client.onEvent((event) => {
  if (event.type === 'content_delta') {
    response += event.delta;
    renderMessage(response);
  }
});

client.onResult((result) => {
  // Final response
  addToHistory(result.response);
  response = '';
});

// Send user message
function sendMessage(text: string) {
  client.send(text);
}
```

### Collaborative Todo List

```typescript
import { createClient } from '@tentickle/client';

const client = createClient({
  url: 'wss://api.example.com',
  userId: currentUser.id,
});

await client.connect();

const todoChannel = client.channel('todo_list');

// Subscribe to updates (all tabs/windows see changes)
todoChannel.subscribe((event) => {
  switch (event.type) {
    case 'task_created':
      addTaskToUI(event.payload.task);
      break;
    case 'task_completed':
      markTaskComplete(event.payload.taskId);
      break;
    case 'task_deleted':
      removeTaskFromUI(event.payload.taskId);
      break;
  }
});

// Create a task
async function createTask(title: string) {
  await todoChannel.publish({
    type: 'create_task',
    payload: { title },
  });
}

// Load initial tasks
async function loadTasks() {
  const response = await todoChannel.request({
    type: 'get_tasks',
    payload: {},
  });
  renderTasks(response.payload.tasks);
}
```

### Tool Confirmation UI

```typescript
import { createClient } from '@tentickle/client';

const client = createClient({ url: '...' });
await client.connect();

client.onToolConfirmation((request, respond) => {
  // Show modal with tool details
  showConfirmationModal({
    title: `Allow "${request.name}"?`,
    message: request.message,
    details: JSON.stringify(request.arguments, null, 2),
    onApprove: () => respond({ approved: true }),
    onDeny: () => respond({ approved: false, reason: 'User denied' }),
    onModify: (newArgs) => respond({
      approved: true,
      modifiedArguments: newArgs,
    }),
  });
});
```

## Error Handling

```typescript
try {
  await client.connect();
} catch (error) {
  console.error('Connection failed:', error);
}

// Connection state changes handle reconnection
client.onConnectionChange((state) => {
  if (state === 'reconnecting') {
    showReconnectingUI();
  } else if (state === 'connected') {
    hideReconnectingUI();
  } else if (state === 'disconnected') {
    showDisconnectedUI();
  }
});
```

## Browser Support

The client works in all modern browsers:
- Chrome 89+
- Firefox 90+
- Safari 15+
- Edge 89+

For older browsers, you may need polyfills for:
- `EventSource` (SSE)
- `WebSocket`
- `crypto.randomUUID` (has internal fallback)

## License

ISC
