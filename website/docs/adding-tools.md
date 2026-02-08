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
