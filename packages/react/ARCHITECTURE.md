# @tentickle/react Architecture

React bindings that wrap `@tentickle/client` with idiomatic hooks and context.

## Philosophy

**Hooks, not components. Primitives, not opinions.**

We provide React primitives for connection, events, and streaming. We don't provide pre-built chat components - that's your UI layer.

```tsx
// What we provide: hooks
const { send, tick } = useSession();
const { text, isStreaming } = useStreamingText();

// What you build: UI
<div>{text}{isStreaming && '|'}</div>
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your React App                          │
│                                                             │
│   <TentickleProvider>                                       │
│       <App>                                                 │
│           useSession()                                      │
│           useStreamingText()                                │
│           useEvents()                                       │
│       </App>                                                │
│   </TentickleProvider>                                      │
│                                                             │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                   @tentickle/react                           │
│                                                             │
│   TentickleProvider                                         │
│       │                                                     │
│       ├── Creates TentickleClient (or uses provided)        │
│       ├── Provides context                                  │
│       └── Cleanup on unmount                                │
│                                                             │
│   Hooks:                                                    │
│       useClient()         → Direct client access            │
│       useSession()        → Session lifecycle               │
│       useConnectionState()→ Connection state                │
│       useEvents()         → Event subscription              │
│       useStreamingText()  → Text accumulation               │
│       useResult()         → Result subscription             │
│       useChannel()        → Custom channel access           │
│                                                             │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                    @tentickle/client                         │
│                                                             │
│   TentickleClient with HTTP/SSE transport                   │
└─────────────────────────────────────────────────────────────┘
```

## Hooks

### useSession(options?)

Session lifecycle management:

```tsx
const {
  sessionId,          // Current session ID
  connectionState,    // 'disconnected' | 'connecting' | 'connected' | 'error'
  isConnected,        // Convenience: state === 'connected'
  isConnecting,       // Convenience: state === 'connecting'
  error,              // Connection error if any
  connect,            // Connect to session
  disconnect,         // Disconnect
  send,               // Send message
  tick,               // Trigger tick
  abort,              // Abort execution
} = useSession({
  sessionId: 'existing-id',  // Optional: connect to existing
  autoConnect: true,         // Default: connect on mount
  initialProps: {},          // Props for new sessions
});
```

### useStreamingText(options?)

Accumulates `content_delta` events into a string:

```tsx
const { text, isStreaming, clear } = useStreamingText();

// text:        Accumulated response text
// isStreaming: True between tick_start and tick_end
// clear:       Reset text and streaming state
```

### useEvents(options?)

Subscribe to raw events (latest only, not accumulated):

```tsx
const { event, clear } = useEvents({
  filter: ['tool_call', 'tool_result'],  // Optional: filter by type
  enabled: true,                          // Optional: disable subscription
});
```

### useConnectionState()

Simple connection state subscription:

```tsx
const state = useConnectionState(); // 'disconnected' | 'connecting' | 'connected' | 'error'
```

### useResult()

Subscribe to execution results:

```tsx
const result = useResult();
// { response, outputs, usage, stopReason }
```

### useChannel(name)

Access custom channels:

```tsx
const channel = useChannel('todos');
channel.subscribe((payload, event) => { ... });
await channel.publish('add', { title: 'Task' });
```

### useClient()

Direct client access for advanced use cases:

```tsx
const client = useClient();
// Full TentickleClient API
```

## Design Decisions

### Events: Latest Only

`useEvents` returns the latest event, not an accumulated array. This prevents unbounded memory growth and keeps state minimal.

```tsx
// We do this:
const { event } = useEvents();

// Not this:
const { events } = useEvents(); // Would grow forever
```

Use `useStreamingText` for accumulated text, or manage your own array if needed.

### Auto-Connect by Default

`useSession({ autoConnect: true })` (default) connects on mount. This matches user expectations for most use cases.

Disable with `autoConnect: false` for manual control.

### No Suspense (v1)

We use `useState` + `useEffect`, not Suspense. Suspense for data fetching is still experimental and adds complexity.

### No Pre-built Components

We don't provide `<ChatMessage>`, `<ChatInput>`, etc. Your UI, your components.

The hooks provide the data; you render it however fits your design system.

## File Structure

```
packages/react/src/
├── index.ts    # Public exports
├── types.ts    # Type definitions
├── context.tsx # TentickleProvider, useClient
└── hooks.ts    # useSession, useEvents, useStreamingText, etc.
```

## What This Doesn't Do

- **UI components** - Build your own chat UI
- **Message history** - Use useEvents + your own state
- **Persistence** - Store sessions in your backend
- **Authentication** - Pass token via clientConfig

We handle Tentickle-specific concerns. React concerns are yours.
