# Agentick Testing Utilities

Test your agents without making real API calls.

## Quick Start

```tsx
import { renderAgent, createTestAdapter, act, cleanup } from "@agentick/core/testing";

afterEach(() => cleanup());

test("agent responds to user", async () => {
  const { send, result, model } = renderAgent(MyAgent);

  await act(async () => {
    await send("Hello!");
  });

  expect(result.current.lastAssistantMessage).toBe("Test response");
  expect(model.getCapturedInputs()).toHaveLength(1);
});
```

## Test Adapter

`createTestAdapter()` creates a mock model for testing.

### Basic Usage

```typescript
// Simple text response
const model = createTestAdapter({
  defaultResponse: "Hello from test!",
});

// With tool calls
const model = createTestAdapter({
  defaultResponse: "I'll search for that",
  toolCalls: [{ name: "search", input: { query: "test" } }],
});

// Dynamic responses
const model = createTestAdapter({
  responseGenerator: (input) => {
    const lastMessage = input.messages.at(-1);
    if (lastMessage?.content.includes("weather")) {
      return "It's sunny!";
    }
    return "I don't understand.";
  },
});
```

### respondWith API

Set the exact response for the next model call with automatic content detection:

```typescript
const model = createTestAdapter();

// Simple text
model.respondWith(["Hello world"]);

// Text + tool call
model.respondWith([
  "Let me search for that",
  { tool: { name: "search", input: { query: "test" } } },
]);

// Parallel tool calls
model.respondWith([
  {
    tool: [
      { name: "search", input: { query: "a" } },
      { name: "search", input: { query: "b" } },
    ],
  },
]);

// With image
model.respondWith(["Here's the image:", { image: { url: "https://example.com/image.png" } }]);

// With reasoning
model.respondWith([{ reasoning: "Let me think about this..." }, "The answer is 42"]);
```

`respondWith` is consumed on the next call - subsequent calls fall back to `defaultResponse`.

### Content Types

| Input                             | Detected As              |
| --------------------------------- | ------------------------ |
| `"text"`                          | Text block               |
| `{ text: "..." }`                 | Explicit text block      |
| `{ tool: { name, input } }`       | Single tool call         |
| `{ tool: [...] }`                 | Parallel tool calls      |
| `{ image: { url } }`              | Image from URL           |
| `{ image: { data, mediaType? } }` | Base64 image             |
| `{ reasoning: "..." }`            | Reasoning/thinking block |

### Automatic Behavior

- **Tool call IDs**: Auto-generated if not provided
- **Stop reason**: Inferred from content (`tool_use` if tools present, `stop` otherwise)
- **Streaming**: `respondWith` works with both `generate()` and `stream()`

### Imperative Methods

```typescript
model.setResponse("New default response");
model.setToolCalls([{ name: "foo", input: {} }]);
model.setError(new Error("Simulated failure"));
model.setStreaming({ enabled: true, chunkSize: 5, chunkDelay: 10 });
```

### Assertions

```typescript
// Check what the model received
const inputs = model.getCapturedInputs();
expect(inputs).toHaveLength(2);
expect(inputs[0].messages).toContainEqual(expect.objectContaining({ role: "user" }));

// Use vitest mocks
expect(model.mocks.execute).toHaveBeenCalledTimes(1);
```

## renderAgent

Full agent lifecycle testing:

```typescript
const { send, result, model, session, rerender } = renderAgent(MyAgent, {
  props: { mode: "helpful" },
  model: createTestAdapter({ defaultResponse: "Hi!" }),
});

// Send messages
await act(() => send("Hello"));

// Check results
expect(result.current.lastAssistantMessage).toBe("Hi!");
expect(result.current.timeline).toHaveLength(2);

// Rerender with new props
await act(() => rerender({ mode: "concise" }));
```

### Options

| Option     | Description                                        |
| ---------- | -------------------------------------------------- |
| `props`    | Props to pass to the agent component               |
| `model`    | Custom test model (default: `createTestAdapter()`) |
| `maxTicks` | Max ticks per execution (default: 10)              |

## compileAgent

Test the compiled structure without execution:

```typescript
const { sections, tools, messages, ephemeral } = await compileAgent(MyAgent, {
  props: { mode: "helpful" },
  messages: [{ role: "user", content: "Hello" }],
});

// Check system prompt
expect(sections.get("instructions")).toContain("helpful");

// Check available tools
expect(tools.map((t) => t.name)).toContain("search");

// Check message rendering
expect(messages).toHaveLength(1);
```

## Async Helpers

```typescript
import { sleep, waitFor, createDeferred, captureAsyncGenerator } from "@agentick/core/testing";

// Wait for condition
await waitFor(() => expect(result.current.done).toBe(true));

// Capture generator output
const events = await captureAsyncGenerator(model.stream(input));

// Control async flow
const deferred = createDeferred<string>();
// ... later
deferred.resolve("done");
```

## act

Wrap state updates like React Testing Library:

```typescript
await act(async () => {
  await send("Hello");
  // All state updates batched
});

// Sync version
actSync(() => {
  model.setResponse("New response");
});
```

## cleanup

Call after each test to reset state:

```typescript
afterEach(() => cleanup());
```

## Testing Patterns

### Testing Tool Execution

```typescript
test("agent uses search tool", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(SearchAgent, { model });

  // First tick: model calls tool
  model.respondWith(["Let me search", { tool: { name: "search", input: { q: "weather" } } }]);

  // Second tick: model responds with result
  model.respondWith(["The weather is sunny!"]);

  await act(() => send("What's the weather?"));

  expect(result.current.lastAssistantMessage).toContain("sunny");
});
```

### Testing Multi-Turn Conversations

```typescript
test("agent remembers context", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(ChatAgent, { model });

  model.respondWith(["I'm Claude, nice to meet you!"]);
  await act(() => send("Hi, I'm Alice"));

  model.respondWith(["Of course, Alice!"]);
  await act(() => send("Remember my name?"));

  expect(result.current.lastAssistantMessage).toContain("Alice");
});
```

### Testing Error Handling

```typescript
test("agent handles model errors", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(ResilientAgent, { model });

  model.setError(new Error("API rate limited"));

  await act(() => send("Hello"));

  expect(result.current.error).toBeDefined();
});
```

## Mock Factories

Test code that consumes `App`, `Session`, or `ExecutionHandle` without a real engine.

### createTestProcedure

Lightweight Procedure stub. Branded with `PROCEDURE_SYMBOL` so `isProcedure()` returns true. Returns `ProcedurePromise` with `.result` chaining. Chainable methods (`.use()`, `.withContext()`, etc.) are no-ops.

```typescript
import { createTestProcedure } from "@agentick/core/testing";

const proc = createTestProcedure({ handler: async (x: number) => x * 2 });
const result = await proc(5).result; // 10

// Spy tracking
expect(proc._callCount).toBe(1);
expect(proc._lastArgs).toEqual([5]);

// Override responses
proc.respondWith("one-shot"); // next call only
proc.setResponse("persistent"); // all subsequent calls
proc.reset(); // clear calls + overrides
```

### createMockSession

Mock `Session` with spy tracking on all procedures. Extends `EventEmitter`.

```typescript
import { createMockSession } from "@agentick/core/testing";

const session = createMockSession({ executionOptions: { response: "Hello!" } });
const handle = await session.send({ messages: [] });
const result = await handle.result;

expect(result.response).toBe("Hello!");
expect(session._sendCalls).toHaveLength(1);

// Override next response
session.respondWith({ response: "Custom!" });
```

### createMockApp

Mock `App` with lazy session creation and lifecycle tracking.

```typescript
import { createMockApp } from "@agentick/core/testing";

const app = createMockApp();
const session = await app.session("test");
expect(app.has("test")).toBe(true);

await app.close("test");
expect(app._closedSessions).toContain("test");
```

### createTestRunner

Mock `ExecutionRunner` with lifecycle call tracking.

```typescript
import { createTestRunner } from "@agentick/core/testing";

// Basic — tracks all lifecycle calls
const { runner, tracker } = createTestRunner();
const app = createApp(Agent, { model, runner });
const session = await app.session();
await session.send({ messages: [...] }).result;

expect(tracker.initCalls).toHaveLength(1);
expect(tracker.prepareModelInputCalls).toHaveLength(1);

// Intercept tools with static string results
const { runner, tracker } = createTestRunner({
  interceptTools: { execute: "sandbox result" },
});
// When model calls "execute" tool, gets "sandbox result" instead of real execution

// Intercept tools with dynamic function results
const { runner: runner2 } = createTestRunner({
  interceptTools: {
    execute: (call) => ({
      id: call.id, toolUseId: call.id, name: call.name,
      success: true,
      content: [{ type: "text", text: `ran: ${call.input.code}` }],
    }),
  },
});

// Transform model input
const { runner } = createTestRunner({
  transformInput: (compiled) => ({ ...compiled, tools: [] }),
});

// Add data to persist snapshots
const { runner } = createTestRunner({
  persistData: { _sandbox: { id: "abc" } },
});

// Reset tracking between tests
tracker.reset();
```

#### Tracker Fields

| Field                    | Tracks                              |
| ------------------------ | ----------------------------------- |
| `initCalls`              | Session IDs from `onSessionInit`    |
| `prepareModelInputCalls` | Tool names from `prepareModelInput` |
| `toolCalls`              | Tool names + intercepted flag       |
| `persistCalls`           | Session IDs from `onPersist`        |
| `restoreCalls`           | Session IDs from `onRestore`        |
| `destroyCalls`           | Session IDs from `onDestroy`        |

### createMockExecutionHandle

Mock `SessionExecutionHandle` with real `EventBuffer` for streaming.

```typescript
import { createMockExecutionHandle } from "@agentick/core/testing";

const handle = createMockExecutionHandle({
  response: "Hello!",
  streamDeltas: ["Hel", "lo!"],
});

for await (const event of handle) {
  console.log(event);
}
```
