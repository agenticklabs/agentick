# Testing

Agentick provides first-class testing utilities — mock adapters, mock apps, and test procedures.

## Test Adapter

`createTestAdapter` creates a mock model that returns scripted responses:

```tsx
import { createTestAdapter } from "@agentick/core/testing";

const adapter = createTestAdapter({
  defaultResponse: "Hello! How can I help?",
});

const result = await run(app, {
  model: adapter,
  messages: [{ role: "user", content: "Hi" }],
});

expect(result.response).toContain("Hello");
```

## Scripted Responses

Control exactly what the model returns, including tool calls:

```tsx
const adapter = createTestAdapter({ defaultResponse: "Done." });

// Queue a tool call response
adapter.respondWith([
  {
    tool: {
      name: "web_search",
      input: { query: "agentick framework" },
    },
  },
]);

// Next call returns the tool call, then default response
const result = await run(app, {
  model: adapter,
  messages: [{ role: "user", content: "Search for agentick" }],
});
```

## Mock App

`createMockApp` creates a mock application with sessions for integration testing:

```tsx
import { createMockApp } from "@agentick/core/testing";

const app = createMockApp();
const session = app._sessions.get("test-session");

// Send a message
await session.send({ messages: [{ role: "user", content: "Hello" }] });

// Verify session state
expect(app._sessions.size).toBeGreaterThan(0);
```

## Test Procedures

`createTestProcedure` from `@agentick/kernel/testing` creates mock procedures for unit testing:

```tsx
import { createTestProcedure } from "@agentick/kernel/testing";

const mockSend = createTestProcedure({
  handler: (input) => ({ response: "mocked" }),
});

// Verify calls
await mockSend({ messages: [] });
expect(mockSend._callCount).toBe(1);
expect(mockSend._lastArgs).toEqual([{ messages: [] }]);

// Override responses
mockSend.respondWith({ response: "custom" }); // One-shot
mockSend.setResponse({ response: "permanent" }); // Persistent
```

## Testing Patterns

### Test a tool handler

```tsx
const result = await MyTool.run({ query: "test" });
expect(result).toContain("expected output");
```

### Test a full agent turn

```tsx
const adapter = createTestAdapter({ defaultResponse: "I'll search for that." });
adapter.respondWith([{ tool: { name: "search", input: { q: "test" } } }]);

const result = await run(myApp, {
  model: adapter,
  messages: [{ role: "user", content: "Search for test" }],
});

expect(result.response).toBeDefined();
```

### Test multi-turn with sessions

```tsx
const adapter = createTestAdapter({ defaultResponse: "Noted." });
const app = createApp(() => (
  <>
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
));

const session = await app.session({ id: "test" });
await session.send({ messages: [{ role: "user", content: "Turn 1" }] });
const result = await session.send({
  messages: [{ role: "user", content: "Turn 2" }],
}).result;

expect(result).toBeDefined();
```
