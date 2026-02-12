# Testing

Agentick provides first-class testing utilities — mock adapters, agent rendering, mock apps, and test runners.

## Test Adapter

`createTestAdapter` creates a mock model that returns scripted responses:

```tsx
import { createTestAdapter } from "@agentick/core/testing";

const adapter = createTestAdapter({
  defaultResponse: "Hello! How can I help?",
});
```

### respondWith

Queue exact responses for the next model call with automatic content detection:

```tsx
const model = createTestAdapter();

// Simple text
model.respondWith(["Hello world"]);

// Text + tool call
model.respondWith([
  "Let me search for that",
  { tool: { name: "search", input: { query: "test" } } },
]);

// With reasoning
model.respondWith([{ reasoning: "Let me think..." }, "The answer is 42"]);
```

`respondWith` is consumed on the next call — subsequent calls fall back to `defaultResponse`.

### Content Types

| Input                       | Detected As              |
| --------------------------- | ------------------------ |
| `"text"`                    | Text block               |
| `{ tool: { name, input } }` | Single tool call         |
| `{ tool: [...] }`           | Parallel tool calls      |
| `{ image: { url } }`        | Image from URL           |
| `{ reasoning: "..." }`      | Reasoning/thinking block |

### Imperative Methods

```tsx
model.setResponse("New default response");
model.setToolCalls([{ name: "foo", input: {} }]);
model.setError(new Error("Simulated failure"));
```

### Assertions

```tsx
const inputs = model.getCapturedInputs();
expect(inputs).toHaveLength(2);
expect(inputs[0].messages).toContainEqual(expect.objectContaining({ role: "user" }));
```

## renderAgent

Full agent lifecycle testing with send, result inspection, and rerender:

```tsx
import { renderAgent, act, cleanup } from "@agentick/core/testing";

afterEach(() => cleanup());

test("agent responds to user", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(MyAgent, { model });

  model.respondWith(["Hi there!"]);
  await act(() => send("Hello"));

  expect(result.current.lastAssistantMessage).toBe("Hi there!");
  expect(model.getCapturedInputs()).toHaveLength(1);
});
```

### Options

| Option     | Description                                        |
| ---------- | -------------------------------------------------- |
| `props`    | Props to pass to the agent component               |
| `model`    | Custom test model (default: `createTestAdapter()`) |
| `maxTicks` | Max ticks per execution (default: 10)              |

## compileAgent

Test the compiled structure without execution:

```tsx
import { compileAgent } from "@agentick/core/testing";

const { sections, tools, messages } = await compileAgent(MyAgent, {
  props: { mode: "helpful" },
  messages: [{ role: "user", content: "Hello" }],
});

expect(sections.get("instructions")).toContain("helpful");
expect(tools.map((t) => t.name)).toContain("search");
```

## Test Runner

`createTestRunner` creates a mock `ExecutionRunner` with lifecycle call tracking:

```tsx
import { createTestRunner } from "@agentick/core/testing";

const { runner, tracker } = createTestRunner();
const app = createApp(Agent, { model, runner });
const session = await app.session();
await session.send({ messages: [...] }).result;

expect(tracker.initCalls).toHaveLength(1);
expect(tracker.transformCompiledCalls).toHaveLength(1);
```

### Intercept Tools

Replace tool execution with test responses:

```tsx
// Static string results
const { runner } = createTestRunner({
  interceptTools: { execute: "sandbox result" },
});

// Dynamic function results
const { runner } = createTestRunner({
  interceptTools: {
    execute: (call) => ({
      id: call.id,
      toolUseId: call.id,
      name: call.name,
      success: true,
      content: [{ type: "text", text: `ran: ${call.input.code}` }],
    }),
  },
});
```

### Tracker Fields

| Field                    | Tracks                              |
| ------------------------ | ----------------------------------- |
| `initCalls`              | Session IDs from `onSessionInit`    |
| `transformCompiledCalls` | Tool names from `transformCompiled` |
| `toolCalls`              | Tool names + intercepted flag       |
| `persistCalls`           | Session IDs from `onPersist`        |
| `restoreCalls`           | Session IDs from `onRestore`        |
| `destroyCalls`           | Session IDs from `onDestroy`        |

## Mock Factories

### createMockSession

```tsx
import { createMockSession } from "@agentick/core/testing";

const session = createMockSession({ executionOptions: { response: "Hello!" } });
const handle = await session.send({ messages: [] });
const result = await handle.result;

expect(result.response).toBe("Hello!");
expect(session._sendCalls).toHaveLength(1);
```

### createMockApp

```tsx
import { createMockApp } from "@agentick/core/testing";

const app = createMockApp();
const session = await app.session("test");
expect(app.has("test")).toBe(true);
```

### createTestProcedure

```tsx
import { createTestProcedure } from "@agentick/kernel/testing";

const mockSend = createTestProcedure({
  handler: (input) => ({ response: "mocked" }),
});

await mockSend({ messages: [] });
expect(mockSend._callCount).toBe(1);

mockSend.respondWith({ response: "custom" }); // One-shot
mockSend.setResponse({ response: "permanent" }); // Persistent
```

## Testing Patterns

### Test tool execution

```tsx
test("agent uses search tool", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(SearchAgent, { model });

  model.respondWith(["Let me search", { tool: { name: "search", input: { q: "weather" } } }]);
  model.respondWith(["The weather is sunny!"]);

  await act(() => send("What's the weather?"));
  expect(result.current.lastAssistantMessage).toContain("sunny");
});
```

### Test multi-turn conversations

```tsx
test("agent remembers context", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(ChatAgent, { model });

  model.respondWith(["Nice to meet you, Alice!"]);
  await act(() => send("Hi, I'm Alice"));

  model.respondWith(["Of course, Alice!"]);
  await act(() => send("Remember my name?"));

  expect(result.current.lastAssistantMessage).toContain("Alice");
});
```

### Test error handling

```tsx
test("agent handles model errors", async () => {
  const model = createTestAdapter();
  const { send, result } = renderAgent(MyAgent, { model });

  model.setError(new Error("API rate limited"));
  await act(() => send("Hello"));

  expect(result.current.error).toBeDefined();
});
```
