# @agentick/react

React bindings for Agentick. Provides hooks around `@agentick/client` for building chat interfaces and real-time AI applications.

## Installation

```bash
pnpm add @agentick/react
```

## Quick Start

```tsx
import { AgentickProvider, useSession, useStreamingText, useContextInfo } from "@agentick/react";

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
    <AgentickProvider clientConfig={{ baseUrl: "/api" }}>
      <Chat />
    </AgentickProvider>
  );
}
```

## Hooks

### `useSession(options?)`

Session management hook. Returns methods for sending messages and managing subscriptions.

```tsx
const {
  sessionId, // Current session ID
  isSubscribed, // Whether subscribed to session events
  subscribe, // Subscribe to session events
  unsubscribe, // Unsubscribe from session events
  send, // Send a message
  abort, // Abort current execution
  close, // Close the session
  accessor, // Direct SessionAccessor for advanced use
} = useSession({
  sessionId: "my-session", // Optional - creates ephemeral session if omitted
  autoSubscribe: true, // Auto-subscribe on mount
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
  text, // Accumulated text from current response
  isStreaming, // Whether currently receiving text
  clear, // Clear accumulated text
} = useStreamingText({
  enabled: true, // Enable/disable subscription
});

// Display with typing indicator
<div>
  {text}
  {isStreaming && <span className="cursor">|</span>}
</div>;
```

### `useContextInfo(options?)`

Subscribe to context utilization information. Updated after each model response with token usage and model capabilities.

```tsx
const {
  contextInfo, // Latest context info (null before first response)
  clear, // Clear context info
} = useContextInfo({
  sessionId: "my-session", // Optional - filter by session
  enabled: true, // Enable/disable subscription
});

if (contextInfo) {
  console.log(contextInfo.modelId); // "gpt-4o" | "claude-3-5-sonnet" | etc.
  console.log(contextInfo.modelName); // Human-readable name
  console.log(contextInfo.provider); // "openai" | "anthropic" | etc.
  console.log(contextInfo.contextWindow); // Total context window size
  console.log(contextInfo.inputTokens); // Input tokens this tick
  console.log(contextInfo.outputTokens); // Output tokens this tick
  console.log(contextInfo.totalTokens); // Total tokens this tick
  console.log(contextInfo.utilization); // Context utilization % (0-100)
  console.log(contextInfo.maxOutputTokens); // Max output tokens for model
  console.log(contextInfo.supportsVision); // Model supports vision
  console.log(contextInfo.supportsToolUse); // Model supports tools
  console.log(contextInfo.isReasoningModel); // Extended thinking model

  // Cumulative usage across all ticks in execution
  console.log(contextInfo.cumulativeUsage?.inputTokens);
  console.log(contextInfo.cumulativeUsage?.outputTokens);
  console.log(contextInfo.cumulativeUsage?.ticks);
}
```

#### ContextInfo Interface

```typescript
interface ContextInfo {
  modelId: string; // Model identifier (e.g., "gpt-4o")
  modelName?: string; // Human-readable name
  provider?: string; // Provider name
  contextWindow?: number; // Context window size in tokens
  inputTokens: number; // Input tokens this tick
  outputTokens: number; // Output tokens this tick
  totalTokens: number; // Total tokens this tick
  utilization?: number; // Context utilization % (0-100)
  maxOutputTokens?: number; // Max output tokens
  supportsVision?: boolean; // Vision capability
  supportsToolUse?: boolean; // Tool use capability
  isReasoningModel?: boolean; // Extended thinking capability
  tick: number; // Current tick number
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
  event, // Latest event
  clear, // Clear current event
} = useEvents({
  sessionId: "my-session", // Optional - filter by session
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
  state, // "disconnected" | "connecting" | "connected"
  isConnected, // Convenience boolean
  isConnecting, // Convenience boolean
} = useConnection();

<div className={`status ${isConnected ? "online" : "offline"}`}>
  {isConnected ? "Connected" : "Disconnected"}
</div>;
```

### `useConnectionState()`

Alias for `useConnection()`. Returns just the connection state string.

```tsx
const state = useConnectionState(); // "disconnected" | "connecting" | "connected"
```

### `useClient()`

Direct access to the underlying `AgentickClient` for advanced use cases.

```tsx
const client = useClient();

// Direct client access
const session = client.session("my-session");
const channel = session.channel("custom");
channel.publish("event", { data: "value" });
```

### `useLineEditor(options)`

React wrapper around `@agentick/client`'s `LineEditor` class. Provides readline-quality editing with completion support via `useSyncExternalStore`.

```tsx
import { useLineEditor } from "@agentick/react";

const { value, cursor, completion, completedRanges, editor } = useLineEditor({
  onSubmit: (text) => send(text),
});

// Register completion sources via the raw editor
useEffect(() => {
  return editor.registerCompletion({
    id: "file",
    match({ value, cursor }) {
      const idx = value.lastIndexOf("#", cursor - 1);
      if (idx < 0) return null;
      return { from: idx, query: value.slice(idx + 1, cursor) };
    },
    resolve: async ({ query }) => searchFiles(query),
  });
}, [editor]);
```

Returns `{ value, cursor, completion, completedRanges, handleInput, setValue, clear, editor }`. The `editor` property is the raw `LineEditor` instance. The `completion` property is `CompletionState | null`.

For terminal UIs, use `useLineEditor` from `@agentick/tui` which adds Ink keystroke normalization. See [`COMPLETION.md`](../client/COMPLETION.md) for the full completion system reference.

### Chat Hooks

These hooks wrap the [Chat Primitives](../client/README.md#chat-primitives) from `@agentick/client`. See the client docs for the underlying `ChatSession`, `MessageLog`, `ToolConfirmations`, and `MessageSteering` classes.

#### `useChat(options?)`

Full chat controller hook — messages, steering, tool confirmations, and attachments in one call. Wraps [`ChatSession`](../client/README.md#chatsession) with `useSyncExternalStore`. Auto-subscribes to the SSE transport by default (set `autoSubscribe: false` to manage subscription separately via `useSession`).

```tsx
import { useChat } from "@agentick/react";

function Chat({ sessionId }: { sessionId: string }) {
  const {
    messages, // ChatMessage[]
    chatMode, // "idle" | "streaming" | "confirming_tool"
    toolConfirmation, // { request, respond } | null
    lastSubmitted, // Optimistic user message text
    queued, // Queued messages
    isExecuting, // Execution in progress
    mode, // "steer" | "queue"
    attachments, // Attachment[] (pending, not yet sent)

    submit, // Send or queue based on mode (drains attachments)
    steer, // Always send immediately (drains attachments)
    queue, // Always queue (no attachments)
    interrupt, // Abort + send (drains attachments)
    flush, // Flush next queued
    respondToConfirmation,
    clearMessages,
    setMode,
    removeQueued,
    clearQueued,
    addAttachment, // (input: AttachmentInput) => Attachment
    removeAttachment, // (id: string) => void
    clearAttachments, // () => void
  } = useChat({ sessionId, mode: "queue" });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id} className={msg.role}>
          {typeof msg.content === "string" ? msg.content : "..."}
        </div>
      ))}

      {toolConfirmation && (
        <dialog open>
          <p>Allow {toolConfirmation.request.name}?</p>
          <button onClick={() => respondToConfirmation({ approved: true })}>Allow</button>
          <button onClick={() => respondToConfirmation({ approved: false })}>Deny</button>
        </dialog>
      )}

      <input
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(e.currentTarget.value);
        }}
      />
    </div>
  );
}
```

Options are captured at mount time. Changing them requires a new `sessionId`.

#### Custom Chat Modes

```tsx
type MyMode = "idle" | "working" | "needs_approval";

const { chatMode } = useChat<MyMode>({
  sessionId,
  deriveMode: ({ isExecuting, hasPendingConfirmation }) => {
    if (hasPendingConfirmation) return "needs_approval";
    if (isExecuting) return "working";
    return "idle";
  },
});
// chatMode is typed as MyMode
```

#### `useMessages(options?)`

Message accumulation only. Use when you don't need steering or confirmations.

```tsx
import { useMessages } from "@agentick/react";

const { messages, clear } = useMessages({
  sessionId: "my-session",
  transform: customTransform, // Optional custom MessageTransform
  initialMessages: [], // Pre-loaded history
});
```

#### `useToolConfirmations(options?)`

Tool confirmation management only. Use for custom confirmation UIs.

```tsx
import { useToolConfirmations } from "@agentick/react";

const { pending, respond } = useToolConfirmations({
  sessionId: "my-session",
  policy: (req) => (req.name === "read_file" ? { action: "approve" } : { action: "prompt" }),
});

if (pending) {
  // Show confirmation UI
  respond({ approved: true });
}
```

#### `useMessageSteering(options?)`

Input-side message routing with queue/steer modes.

```tsx
import { useMessageSteering } from "@agentick/react";

const { queued, isExecuting, mode, submit, steer, queue, interrupt, flush, setMode } =
  useMessageSteering({
    sessionId: "my-session",
    mode: "queue",
    flushMode: "sequential",
  });
```

#### Progressive Disclosure

| Level | Hook                                                          | Use case                             |
| ----- | ------------------------------------------------------------- | ------------------------------------ |
| 0     | `useChat`                                                     | Full chat — one hook does everything |
| 1     | `useChat` + options                                           | Custom modes, policies, transforms   |
| 2     | `useMessages` + `useToolConfirmations` + `useMessageSteering` | Compose individual primitives        |
| 3     | `useEvents` + custom reducer                                  | Full control, build your own         |

## Provider

### `AgentickProvider`

Wraps your app to provide the Agentick client context.

```tsx
<AgentickProvider
  clientConfig={{
    baseUrl: "https://api.example.com", // Required - API base URL
    token: "auth-token", // Optional - auth token
  }}
>
  <App />
</AgentickProvider>
```

## Types

All hooks are fully typed. Import types from the package:

```typescript
import type {
  // Provider types
  AgentickProviderProps,
  AgentickContextValue,
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

  // Chat hook types
  UseChatOptions,
  UseChatResult,
  UseMessagesOptions,
  UseMessagesResult,
  UseToolConfirmationsOptions,
  UseToolConfirmationsResult,
  UseMessageSteeringOptions,
  UseMessageSteeringResult,
  ChatMode,
  ChatMessage,
  ToolConfirmationState,
  SteeringMode,
  FlushMode,

  // Re-exported from @agentick/client
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SessionAccessor,
  SendInput,
  ClientExecutionHandle,
  SessionStreamEvent,
  ClientTransport,
} from "@agentick/react";

// Transform functions (re-exported from @agentick/client)
import {
  timelineToMessages,
  extractToolCalls,
  defaultTransform,
  defaultDeriveMode,
} from "@agentick/react";
```

## License

MIT
