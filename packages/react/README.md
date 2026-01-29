# @tentickle/react

React hooks for Tentickle clients.

## Installation

```bash
npm install @tentickle/react @tentickle/client
# or
pnpm add @tentickle/react @tentickle/client
```

## Quick Start

```tsx
import { TentickleProvider, useSession, useStreamingText } from "@tentickle/react";

function App() {
  return (
    <TentickleProvider config={{ baseUrl: "https://api.example.com" }}>
      <Chat />
    </TentickleProvider>
  );
}

function Chat() {
  const { connect, send, isConnected } = useSession();
  const { text, isStreaming } = useStreamingText();

  useEffect(() => {
    connect();
  }, []);

  const handleSend = async (message: string) => {
    await send(message);
  };

  return (
    <div>
      <div>{text}{isStreaming && <span className="cursor">|</span>}</div>
      <input onKeyDown={(e) => e.key === "Enter" && handleSend(e.target.value)} />
    </div>
  );
}
```

## API

### TentickleProvider

Provides Tentickle client context to child components.

```tsx
<TentickleProvider config={{ baseUrl: "https://api.example.com", token: "..." }}>
  {children}
</TentickleProvider>
```

### useSession()

Access session state and methods.

```typescript
const {
  // State
  sessionId,
  connectionState,
  isConnected,
  isConnecting,
  error,

  // Methods
  connect,
  disconnect,
  send,
  tick,
  abort,
} = useSession();
```

### useConnectionState()

Subscribe to connection state only.

```typescript
const connectionState = useConnectionState();
// "disconnected" | "connecting" | "connected" | "error"
```

### useStreamingText()

Subscribe to streaming text accumulation.

```typescript
const { text, isStreaming } = useStreamingText();
```

### useEvents(handler, deps?)

Subscribe to all stream events.

```typescript
useEvents((event) => {
  if (event.type === "tool_call") {
    console.log("Tool called:", event.name);
  }
});
```

### useResult(handler, deps?)

Subscribe to execution results.

```typescript
useResult((result) => {
  console.log("Response:", result.response);
  console.log("Usage:", result.usage);
});
```

### useChannel(name)

Access a named channel for pub/sub.

```typescript
const { subscribe, publish, request } = useChannel("todos");

useEffect(() => {
  return subscribe((payload, event) => {
    console.log("Channel event:", event.type, payload);
  });
}, []);

const addTodo = () => publish("add", { title: "New task" });
```

### useTentickle()

Access the underlying TentickleClient directly.

```typescript
const client = useTentickle();
```

## TypeScript

All hooks are fully typed. Import types from the package:

```typescript
import type {
  TentickleConfig,
  SessionState,
  StreamingTextState,
  ConnectionState,
  StreamEvent,
} from "@tentickle/react";
```

## License

MIT
