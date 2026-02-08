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
    return results.map(r => `${r.title}: ${r.snippet}`).join("\n");
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
console.log(SearchTool.metadata.name);        // "web_search"
console.log(SearchTool.metadata.description);  // "Search the web..."
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
        : todos.map((t, i) =>
            `${i}. [${t.done ? "x" : " "}] ${t.text}`
          ).join("\n")}
    </Section>
  ),
});
```

The `render` function is a React component. It's part of the fiber tree. When tool state changes, the reconciler diffs and the model sees updated context on the next tick.

## Tool Handler Signature

```typescript
(input: TInput, ctx?: COM) => TOutput | Promise<TOutput>
```

The `ctx` parameter provides access to the Context Object Model — session state, emit events, etc.

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
