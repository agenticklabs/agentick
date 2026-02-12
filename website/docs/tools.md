# Tools

Tools are functions the model can call. In agentick, tools are components — they mount into the fiber tree, register with the model, and can render context.

## createTool

The primary way to define tools. Returns a **ToolClass**: a JSX component with static methods.

```tsx
import { createTool } from "agentick";
import { z } from "zod";

const SearchTool = createTool({
  name: "web_search",
  description: "Search the web for information",
  input: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().default(5),
  }),
  handler: async ({ query, maxResults }) => {
    const results = await searchWeb(query, maxResults);
    return results.map((r) => `${r.title}: ${r.snippet}`).join("\n");
  },
});
```

### As JSX Component

```tsx
function MyAgent() {
  return (
    <>
      <System>You are a research assistant.</System>
      <SearchTool />
      <Timeline />
    </>
  );
}
```

### Static Methods

```tsx
// Run programmatically (outside JSX)
const result = await SearchTool.run({ query: "agentick" });

// Access metadata
console.log(SearchTool.metadata.name); // "web_search"
console.log(SearchTool.metadata.description); // "Search the web..."
```

## Inline Tools

For simple tools, define them inline with `<Tool>`:

```tsx
<Tool
  name="greet"
  description="Greet someone"
  input={z.object({ name: z.string() })}
  handler={({ name }) => `Hello, ${name}!`}
/>
```

## Stateful Tools

Tools can render context to the model via the `render` function. This is the recommended pattern for tools that manage collections or state.

```tsx
const TodoTool = createTool({
  name: "manage_todos",
  description: "Add, complete, or remove todos",
  input: z.object({
    action: z.enum(["add", "complete", "remove"]),
    text: z.string().optional(),
    index: z.number().optional(),
  }),
  handler: async ({ action, text, index }, ctx) => {
    switch (action) {
      case "add":
        todos.push({ text: text!, done: false });
        return `Added: ${text}`;
      case "complete":
        todos[index!].done = true;
        return `Completed: ${todos[index!].text}`;
      case "remove":
        const removed = todos.splice(index!, 1);
        return `Removed: ${removed[0].text}`;
    }
  },
  render: () => (
    <Section id="todo-state" audience="model">
      ## Current Todos
      {todos.length === 0
        ? "No todos yet."
        : todos.map((t, i) => `${i}. [${t.done ? "x" : " "}] ${t.text}`).join("\n")}
    </Section>
  ),
});
```

The `render` function is a React component. It's part of the fiber tree. When tool state changes, the reconciler diffs and the model sees updated context on the next tick.

## Context Injection with `use()`

Tools exist at module scope but often need tree-scoped context — a sandbox, database, or React Context value. The `use()` hook runs at render time and passes captured values to the handler as **deps**.

```tsx
const ShellTool = createTool({
  name: "shell",
  description: "Execute a command in the sandbox",
  input: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ command }, deps) => {
    const result = await deps!.sandbox.exec(command);
    return [{ type: "text", text: result.stdout }];
  },
});
```

The handler's second argument is `{ ctx, ...useReturn }` when rendered in JSX, or `undefined` when called via `.run()`. This makes dependencies explicit and tree-scoped — two `<ShellTool />`s under different providers get different sandboxes.

```tsx
// Each tool instance captures its own provider's sandbox
<SandboxProvider sandbox={localSandbox}>
  <ShellTool />
</SandboxProvider>
<SandboxProvider sandbox={remoteSandbox}>
  <ShellTool />
</SandboxProvider>
```

## Tool Handler Signature

Without `use()`:

```typescript
(input: TInput, ctx?: COM) => TOutput | Promise<TOutput>;
```

With `use()`:

```typescript
(input: TInput, deps?: { ctx: COM } & TDeps) => TOutput | Promise<TOutput>;
```

The `ctx` parameter (or `deps.ctx`) provides access to the Context Object Model — session state, emit events, etc.

```tsx
handler: async ({ query }, ctx) => {
  ctx?.setState("lastQuery", query);
  ctx?.emit("search:started", { query });
  const results = await search(query);
  return results;
},
```

## Tool Output Types

Handlers can return:

- **String**: plain text result
- **Object**: serialized as JSON
- **Array of content blocks**: `[{ type: "text", text: "..." }]` for rich responses

## Overriding Props in JSX

Pre-built tools ship with default metadata, but you can customize any metadata field via JSX props. This lets you tailor tool descriptions, names, or behavior without creating new tools.

```tsx
import { Shell, EditFile } from "@agentick/sandbox";

function Agent() {
  return (
    <>
      <Shell description="Run commands. Prefer one-liners." />
      <EditFile description="Apply surgical edits. Include enough surrounding context to uniquely match." />
      <Shell name="bash" requiresConfirmation={true} />
    </>
  );
}
```

Overridable fields: `name`, `description`, `requiresConfirmation`, `confirmationMessage`, `intent`, `type`, `providerOptions`, `libraryOptions`.

Props take precedence over the tool's built-in defaults. Unset props (or `undefined`) leave the original value unchanged.

## Tool Sources

Tools can come from four sources, listed from lowest to highest priority:

| Source         | Where                                | Lifetime      |
| -------------- | ------------------------------------ | ------------- |
| App-level      | `createApp(Agent, { tools: [...] })` | All sessions  |
| Session-level  | `app.session({ tools: [...] })`      | One session   |
| Per-execution  | `session.send({ tools: [...] })`     | One execution |
| JSX-reconciled | `<MyTool />` in the component tree   | While mounted |

When multiple sources define a tool with the same name, the highest-priority source wins.

```tsx
const SearchTool = createTool({ name: "search", description: "Web search", ... });
const FileTool = createTool({ name: "search", description: "File search", ... });

// App-level: available to all sessions
const app = createApp(Agent, { tools: [SearchTool] });

// Session-level: available for this session's lifetime
const session = await app.session({ tools: [FileTool] });

// Per-execution: available only during this send()
await session.send({
  messages: [...],
  tools: [DynamicTool],
});

// JSX: highest priority, re-evaluated each tick
function Agent() {
  return <SearchTool description="Custom description" />;
}
```

### Priority Resolution

On each tick, tools merge in order: app → session → execution → JSX. Last-in wins by name.

If your JSX tree renders `<SearchTool />` and `createApp` also passes a `SearchTool`, the JSX version's metadata (including any prop overrides) takes precedence.

### Per-Execution Tools

Tools passed via `session.send({ tools: [...] })` are scoped to that execution only. They are cleared when the execution ends. This is useful for dynamic tool injection — e.g., providing different tools based on user input.

```tsx
// First execution: search + calculator
await session.send({
  messages: [{ role: "user", content: [{ type: "text", text: "Calculate something" }] }],
  tools: [CalculatorTool],
});

// Second execution: search only (calculator is gone)
await session.send({
  messages: [{ role: "user", content: [{ type: "text", text: "Search for something" }] }],
});
```

### Spawned Sessions

`session.spawn()` creates a fresh child session. Spawned sessions do **not** inherit tools from the parent — they start with only the tools defined in their own JSX tree and any tools passed via `createApp`.

```tsx
// Parent has SearchTool in its JSX tree
function ParentAgent() {
  return (
    <>
      <SearchTool />
      <System>You are a research assistant.</System>
      <Timeline />
    </>
  );
}

// Child defines its own tools — does NOT inherit SearchTool
function ChildAgent() {
  return (
    <>
      <WriteFile />
      <System>You are a writer.</System>
      <Timeline />
    </>
  );
}

// Spawn a child — it only has WriteFile, not SearchTool
await session.spawn(ChildAgent, { messages: [...] });
```
