# @tentickle/react

React bindings for Tentickle. Provides hooks around `@tentickle/client` for building chat interfaces and real-time AI applications.

## Installation

```bash
pnpm add @tentickle/react
```

## Quick Start

```tsx
import { TentickleProvider, useSession, useStreamingText, useContextInfo } from "@tentickle/react";

function Chat() {
  const { send } = useSession({ sessionId: "my-session", autoSubscribe: true });
  const { text, isStreaming } = useStreamingText();
  const { contextInfo } = useContextInfo();

  return (
    <div>
      <div className="response">
        {text}
        {isStreaming && <span className="cursor">|</span>}
      </div>

      {contextInfo && (
        <div className="context-bar">
          <span>{contextInfo.modelName}</span>
          <span>{contextInfo.utilization?.toFixed(1)}% context used</span>
        </div>
      )}

      <button onClick={() => send("Hello!")}>Send</button>
    </div>
  );
}

export function App() {
  return (
    <TentickleProvider clientConfig={{ baseUrl: "/api" }}>
      <Chat />
    </TentickleProvider>
  );
}
```

## Hooks

### `useSession(options?)`

Session management hook. Returns methods for sending messages and managing subscriptions.

```tsx
const {
  sessionId,      // Current session ID
  isSubscribed,   // Whether subscribed to session events
  subscribe,      // Subscribe to session events
  unsubscribe,    // Unsubscribe from session events
  send,           // Send a message
  abort,          // Abort current execution
  close,          // Close the session
  accessor,       // Direct SessionAccessor for advanced use
} = useSession({
  sessionId: "my-session",  // Optional - creates ephemeral session if omitted
  autoSubscribe: true,      // Auto-subscribe on mount
});

// Send a simple text message
await send("Hello!");

// Send with full message structure
await send({
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello!" }],
  },
});
```

### `useStreamingText(options?)`

Subscribe to streaming text from model responses. Automatically accumulates text deltas.

```tsx
const {
  text,        // Accumulated text from current response
  isStreaming, // Whether currently receiving text
  clear,       // Clear accumulated text
} = useStreamingText({
  enabled: true,  // Enable/disable subscription
});

// Display with typing indicator
<div>
  {text}
  {isStreaming && <span className="cursor">|</span>}
</div>
```

### `useContextInfo(options?)`

Subscribe to context utilization information. Updated after each model response with token usage and model capabilities.

```tsx
const {
  contextInfo,  // Latest context info (null before first response)
  clear,        // Clear context info
} = useContextInfo({
  sessionId: "my-session",  // Optional - filter by session
  enabled: true,            // Enable/disable subscription
});

if (contextInfo) {
  console.log(contextInfo.modelId);         // "gpt-4o" | "claude-3-5-sonnet" | etc.
  console.log(contextInfo.modelName);       // Human-readable name
  console.log(contextInfo.provider);        // "openai" | "anthropic" | etc.
  console.log(contextInfo.contextWindow);   // Total context window size
  console.log(contextInfo.inputTokens);     // Input tokens this tick
  console.log(contextInfo.outputTokens);    // Output tokens this tick
  console.log(contextInfo.totalTokens);     // Total tokens this tick
  console.log(contextInfo.utilization);     // Context utilization % (0-100)
  console.log(contextInfo.maxOutputTokens); // Max output tokens for model
  console.log(contextInfo.supportsVision);  // Model supports vision
  console.log(contextInfo.supportsToolUse); // Model supports tools
  console.log(contextInfo.isReasoningModel);// Extended thinking model

  // Cumulative usage across all ticks in execution
  console.log(contextInfo.cumulativeUsage?.inputTokens);
  console.log(contextInfo.cumulativeUsage?.outputTokens);
  console.log(contextInfo.cumulativeUsage?.ticks);
}
```

#### ContextInfo Interface

```typescript
interface ContextInfo {
  modelId: string;           // Model identifier (e.g., "gpt-4o")
  modelName?: string;        // Human-readable name
  provider?: string;         // Provider name
  contextWindow?: number;    // Context window size in tokens
  inputTokens: number;       // Input tokens this tick
  outputTokens: number;      // Output tokens this tick
  totalTokens: number;       // Total tokens this tick
  utilization?: number;      // Context utilization % (0-100)
  maxOutputTokens?: number;  // Max output tokens
  supportsVision?: boolean;  // Vision capability
  supportsToolUse?: boolean; // Tool use capability
  isReasoningModel?: boolean;// Extended thinking capability
  tick: number;              // Current tick number
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}
```

### `useEvents(options?)`

Subscribe to raw stream events. Use for advanced event handling.

```tsx
const {
  event,  // Latest event
  clear,  // Clear current event
} = useEvents({
  sessionId: "my-session",              // Optional - filter by session
  filter: ["tool_call", "tool_result"], // Optional - filter by event type
  enabled: true,
});

useEffect(() => {
  if (event?.type === "tool_call") {
    console.log("Tool called:", event.name);
  }
}, [event]);
```

### `useConnection()`

Connection state for the SSE transport.

```tsx
const {
  state,         // "disconnected" | "connecting" | "connected"
  isConnected,   // Convenience boolean
  isConnecting,  // Convenience boolean
} = useConnection();

<div className={`status ${isConnected ? "online" : "offline"}`}>
  {isConnected ? "Connected" : "Disconnected"}
</div>
```

### `useConnectionState()`

Alias for `useConnection()`. Returns just the connection state string.

```tsx
const state = useConnectionState(); // "disconnected" | "connecting" | "connected"
```

### `useClient()`

Direct access to the underlying `TentickleClient` for advanced use cases.

```tsx
const client = useClient();

// Direct client access
const session = client.session("my-session");
const channel = session.channel("custom");
channel.publish("event", { data: "value" });
```

## Provider

### `TentickleProvider`

Wraps your app to provide the Tentickle client context.

```tsx
<TentickleProvider
  clientConfig={{
    baseUrl: "https://api.example.com",  // Required - API base URL
    token: "auth-token",                  // Optional - auth token
  }}
>
  <App />
</TentickleProvider>
```

## Types

All hooks are fully typed. Import types from the package:

```typescript
import type {
  // Provider types
  TentickleProviderProps,
  TentickleContextValue,
  TransportConfig,

  // Hook types
  UseConnectionOptions,
  UseConnectionResult,
  UseSessionOptions,
  UseSessionResult,
  UseEventsOptions,
  UseEventsResult,
  UseStreamingTextOptions,
  UseStreamingTextResult,
  UseContextInfoOptions,
  UseContextInfoResult,
  ContextInfo,

  // Re-exported from @tentickle/client
  TentickleClient,
  ConnectionState,
  StreamEvent,
  SessionAccessor,
  SendInput,
  ClientExecutionHandle,
  SessionStreamEvent,
  ClientTransport,
} from "@tentickle/react";
```

## License

MIT
