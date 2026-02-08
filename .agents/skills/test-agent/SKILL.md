---
name: test-agent
description: Test an agentick agent with mock model responses. Use when asked to write tests, test an agent, or verify agent behavior.
---

# Test an Agent

Agentick provides testing utilities in `@agentick/core/testing` for testing agents without real API calls.

## Test Adapter

```typescript
import { createTestAdapter } from "@agentick/core/testing";

// Simple text response
const adapter = createTestAdapter({ defaultResponse: "Hello!" });

// Scripted tool calls
adapter.respondWith([{ tool: { name: "search", input: { query: "test" } } }]);

// Sequence of responses
adapter.respondWith("First response");
adapter.respondWith("Second response");
// Responses are consumed in order; falls back to defaultResponse after
```

## Full Agent Test

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "@agentick/core";
import { createTestAdapter, cleanup } from "@agentick/core/testing";

describe("MyAgent", () => {
  afterEach(() => cleanup());

  it("responds to messages", async () => {
    const adapter = createTestAdapter({ defaultResponse: "I can help!" });

    const app = createApp(() => (
      <>
        <Model model={adapter} />
        <System>You are helpful.</System>
        <MyTool />
        <Timeline />
      </>
    ));

    const result = await app.run({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    }).result;

    expect(result.response).toBe("I can help!");
  });

  it("handles tool calls", async () => {
    const adapter = createTestAdapter({ defaultResponse: "Done." });
    adapter.respondWith([
      { tool: { name: "my_tool", input: { action: "add", text: "item" } } },
    ]);

    const app = createApp(() => (
      <>
        <Model model={adapter} />
        <System>You manage items.</System>
        <MyTool />
        <Timeline />
      </>
    ));

    const result = await app.run({
      messages: [{ role: "user", content: [{ type: "text", text: "Add an item" }] }],
    }).result;

    // First tick: tool call. Second tick: "Done." response.
    expect(result.response).toBe("Done.");
  });
});
```

## Session Tests

```typescript
it("maintains state across messages", async () => {
  const adapter = createTestAdapter({ defaultResponse: "ok" });
  const app = createApp(MyAgent);
  const session = await app.session({ id: "test-session" });

  // First message
  await session.send({
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  }).result;

  // Second message (same session)
  const result = await session.send({
    messages: [{ role: "user", content: [{ type: "text", text: "Remember me?" }] }],
  }).result;

  expect(result).toBeDefined();
});
```

## Mock App & Session

For testing code that consumes sessions (gateways, middleware):

```typescript
import { createMockApp, createMockSession } from "@agentick/core/testing";

const app = createMockApp();
const session = createMockSession();
```

## Test Procedure

For testing code that consumes procedures:

```typescript
import { createTestProcedure } from "@agentick/kernel/testing";

const proc = createTestProcedure({
  handler: (input: string) => `processed: ${input}`,
});

const result = await proc("hello").result;
expect(result).toBe("processed: hello");
expect(proc._callCount).toBe(1);
expect(proc._lastArgs).toEqual(["hello"]);
```

## Key Files

- Test adapter: `packages/core/src/testing/test-adapter.ts`
- Mock utilities: `packages/core/src/testing/mock-app.ts`
- Render helpers: `packages/core/src/testing/render-agent.ts`
- Async helpers: `packages/core/src/testing/async-helpers.ts`
- Testing index: `packages/core/src/testing/index.ts`

## Running Tests

```bash
pnpm test                              # All tests
pnpm --filter @agentick/core test      # Core tests only
pnpm vitest run path/to/file.spec.ts   # Single file
pnpm vitest --watch                    # Watch mode
```
