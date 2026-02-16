---
name: create-tool
description: Create a new agentick tool using createTool. Use when asked to add a tool, create a tool, or implement tool functionality.
---

# Create a Tool

Tools in agentick are created with `createTool` from `agentick` (or `@agentick/core`). A tool is triple-purpose: JSX component, callable function, and model-registered function.

## Steps

1. Create a file: `my-tool.ts` or `my-tool.tsx` (use `.tsx` if the tool has a `render` function)

2. Define the tool:

```tsx
import { createTool } from "agentick";
import { z } from "zod";

export const MyTool = createTool({
  name: "my_tool",
  description: "What this tool does — the model reads this",
  input: z.object({
    param: z.string().describe("Parameter description for the model"),
  }),
  handler: async ({ param }, ctx) => {
    // ctx is COM — available during agent execution, undefined for standalone calls
    const result = doSomething(param);
    ctx?.setState("lastResult", result); // Optional: persist to session state
    return [{ type: "text", text: JSON.stringify(result) }];
  },
});
```

3. Use the tool in a component tree:

```tsx
function MyAgent() {
  return (
    <>
      <OpenAIModel model="gpt-4o" />
      <System>You are helpful.</System>
      <MyTool />
      <Timeline />
    </>
  );
}
```

## Stateful Tool (with render)

If the tool manages a collection or state the model should see:

```tsx
import { createTool } from "agentick";
import { Section, H2, List, ListItem } from "agentick";

const items: string[] = [];

export const ItemTool = createTool({
  name: "manage_items",
  description: "Add or remove items",
  input: z.object({
    action: z.enum(["add", "remove"]),
    text: z.string(),
  }),
  handler: async ({ action, text }, ctx) => {
    if (action === "add") items.push(text);
    if (action === "remove") {
      const i = items.indexOf(text);
      if (i >= 0) items.splice(i, 1);
    }
    return [{ type: "text", text: `${action}: ${text}` }];
  },
  render: () => (
    <Section id="items" audience="model">
      <H2>Current Items</H2>
      <List>
        {items.map((item) => (
          <ListItem>{item}</ListItem>
        ))}
      </List>
    </Section>
  ),
});
```

Use semantic components (`<H2>`, `<List>`, `<ListItem>`, `<Table>`, `<Json>`) in `render`, not raw markdown strings.

## Context Injection with `use()`

When a tool needs access to tree-scoped context (a sandbox, database, React Context value), use the `use()` hook to bridge render-time context into the handler:

```tsx
import { createTool } from "agentick";
import { z } from "zod";

export const ShellTool = createTool({
  name: "shell",
  description: "Execute a command in the sandbox",
  input: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }), // runs at render time
  handler: async ({ command }, deps) => {
    // deps = { ctx, sandbox } when in JSX; undefined for .run()
    const result = await deps!.sandbox.exec(command);
    return [{ type: "text", text: result.stdout }];
  },
});
```

- `use()` runs every render, capturing fresh values from the component tree
- Deps include `ctx` (COM) plus whatever `use()` returns
- Direct `.run()` calls skip `use()` — deps is `undefined`
- Type inference flows from `use()` return type into the handler's deps parameter
- Two instances of `<ShellTool />` under different providers get different sandboxes

**When to use `use()`**: The tool handler needs something from the component tree — a provider value, a custom hook result, a context-scoped service. If the tool only needs COM state, plain `ctx` (without `use()`) is sufficient.

## User-Audience Tools

`audience: "user"` is a **visibility flag** — the tool is hidden from the model but still registered in COM. It can only be reached via `session.dispatch()` (which works on any tool, not just user-audience ones).

```tsx
import { createTool } from "agentick";
import { z } from "zod";

export const AddDirCommand = createTool({
  name: "add-dir",
  description: "Mount an additional directory into the sandbox",
  input: z.object({
    path: z.string().describe("Absolute path to mount"),
  }),
  audience: "user",
  aliases: ["mount", "add-directory"],
  handler: async ({ path }, deps) => {
    await deps!.sandbox.mount(path);
    return [{ type: "text", text: `Mounted ${path}` }];
  },
  use: () => ({ sandbox: useSandbox() }),
});
```

- `audience: "user"` — **visibility**: excluded from model tool definitions, invisible to the model
- `dispatch(name, input)` — **invocation**: call any tool by name from user code (works on regular tools too)
- `aliases` — alternative names for dispatch lookup (`session.dispatch("mount", input)`)
- Input validated against the Zod schema before handler execution
- Use for: slash commands, TUI actions, admin operations, anything user-initiated

## Handler Signature

Without `use()`:

```typescript
type ToolHandler = (input: TInput, ctx?: COM) => ContentBlock[] | Promise<ContentBlock[]>;
```

With `use()`:

```typescript
type ToolHandler = (
  input: TInput,
  deps?: { ctx: COM } & TDeps,
) => ContentBlock[] | Promise<ContentBlock[]>;
```

- `ctx` (or `deps.ctx`) is the COM (Component Object Model) — session state, getState/setState
- `ctx`/`deps` is `undefined` when called via `MyTool.run(input)` outside an execution
- Return `ContentBlock[]` — typically `[{ type: "text", text: "..." }]`

## Key Files

- Tool factory: `packages/core/src/tool/tool.ts`
- Tool types: `packages/core/src/tool/index.ts`
- Semantic components: `packages/core/src/jsx/components/semantic.tsx`
- Content blocks: `packages/core/src/jsx/components/content.tsx`
- Example: `example/express/src/tools/`

## Testing

```typescript
import { describe, it, expect } from "vitest";

describe("MyTool", () => {
  it("runs standalone", async () => {
    const result = await MyTool.run({ param: "test" }).result;
    expect(result).toBeDefined();
  });
});
```

For integration testing with a mock model, see the `test-agent` skill.
