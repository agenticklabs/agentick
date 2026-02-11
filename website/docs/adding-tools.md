# Adding Tools

Deep dive into tool patterns — inline tools, createTool, composition, and advanced usage.

## Inline vs createTool

**Inline** — for simple, one-off tools:

```tsx
<Tool
  name="greet"
  description="Greet someone"
  input={z.object({ name: z.string() })}
  handler={({ name }) => `Hello, ${name}!`}
/>
```

**createTool** — for reusable tools with static access:

```tsx
const GreetTool = createTool({
  name: "greet",
  description: "Greet someone",
  input: z.object({ name: z.string() }),
  handler: ({ name }) => `Hello, ${name}!`,
});

// Use as component
<GreetTool />;

// Call programmatically
await GreetTool.run({ name: "Ryan" });
```

Use `createTool` when you need to reuse the tool across agents or call it programmatically. Use inline `<Tool>` for agent-specific tools that won't be shared.

## Tool Composition

Tools are components — they compose like any React component:

```tsx
function DataTools({ database }: { database: Database }) {
  return (
    <>
      <Tool
        name="query"
        description="Run a SQL query"
        input={z.object({ sql: z.string() })}
        handler={({ sql }) => database.query(sql)}
      />
      <Tool
        name="schema"
        description="Get table schema"
        input={z.object({ table: z.string() })}
        handler={({ table }) => database.schema(table)}
      />
    </>
  );
}

// Use in any agent
<DataTools database={productionDb} />;
```

## Async Handlers

Handlers can be async. The execution waits for the promise to resolve before proceeding to the next tick.

```tsx
const FetchTool = createTool({
  name: "fetch_url",
  description: "Fetch content from a URL",
  input: z.object({ url: z.string().url() }),
  handler: async ({ url }) => {
    const res = await fetch(url);
    if (!res.ok) return `Error: ${res.status}`;
    return await res.text();
  },
});
```

## Context Object Model (ctx)

The second argument to handlers is the `ctx` — the Context Object Model:

```tsx
handler: async ({ query }, ctx) => {
  // Set session state
  ctx?.setState("lastQuery", query);

  // Emit an event
  ctx?.emit("search:started", { query });

  // Read state
  const count = ctx?.getState("searchCount") ?? 0;
  ctx?.setState("searchCount", count + 1);

  return results;
},
```

## Context Injection with `use()`

Tools defined at module scope can't access React Context directly in their handlers. The `use()` hook solves this — it runs at render time, captures values from the tree, and passes them to the handler as deps.

**The problem**: You have a `<SandboxProvider>` that provides a sandbox via React Context. A tool needs that sandbox, but its handler runs outside the component tree.

**The solution**: `use()` bridges the gap.

```tsx
const ShellTool = createTool({
  name: "shell",
  description: "Run a shell command",
  input: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ command }, deps) => {
    const result = await deps!.sandbox.exec(command);
    return [{ type: "text", text: result.stdout }];
  },
});
```

The deps parameter is `{ ctx, sandbox }` when rendered in JSX, `undefined` when called via `.run()`. This makes it safe — direct calls still work, they just don't get tree context.

**Multiple providers**: Two tool instances under different providers capture different values:

```tsx
<SandboxProvider sandbox={localSandbox}>
  <ShellTool />  {/* gets localSandbox */}
</SandboxProvider>
<SandboxProvider sandbox={dockerSandbox}>
  <ShellTool />  {/* gets dockerSandbox */}
</SandboxProvider>
```

**When to use `use()`**: When your tool handler needs something from the component tree — a provider value, a custom hook result, a context-scoped service. If the tool only needs COM state, plain `ctx` is sufficient.

## Error Handling

Throw from handlers to return tool errors to the model:

```tsx
handler: async ({ id }) => {
  const item = await db.find(id);
  if (!item) throw new Error(`Item ${id} not found`);
  return item;
},
```

The error message is sent back to the model as the tool result. The model can then decide how to proceed.
