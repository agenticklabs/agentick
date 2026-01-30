# @tentickle/react

React bindings for Tentickle. Provides hooks around `@tentickle/client`.

## Installation

```bash
pnpm add @tentickle/react
```

## Quick Start

```tsx
import { TentickleProvider, useSession, useEvents } from "@tentickle/react";

function Chat() {
  const session = useSession("conv-123", { autoSubscribe: true });
  useEvents((event) => {
    if (event.type === "content_delta") {
      console.log(event.delta);
    }
  }, [session.sessionId]);

  const send = async (text: string) => {
    const handle = session.send(text);
    await handle.result;
  };

  return <button onClick={() => send("Hello")}>Send</button>;
}

export function App() {
  return (
    <TentickleProvider config={{ baseUrl: "/api/agent" }}>
      <Chat />
    </TentickleProvider>
  );
}
```

## Hooks

### `useSession(sessionId, options?)`

Returns a session accessor with `send`, `subscribe`, `unsubscribe`, `onEvent`, and `channel`.

### `useEvents(handler, deps?)`

Global event stream handler. Events include `sessionId`.

### `useConnection()`

Read-only connection state.

All hooks are fully typed. Import types from the package:

```typescript
import type {
  TentickleConfig,
  StreamingTextState,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  ClientExecutionHandle,
} from "@tentickle/react";
```

## License

MIT
