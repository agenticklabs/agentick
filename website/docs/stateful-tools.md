# Stateful Tools

Stateful tools manage data AND render it to the model context. The `render` function in `createTool` is a React component that becomes part of the fiber tree.

## The Pattern

```tsx
const todos: Todo[] = [];

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
        ctx?.setState("lastAction", `Added: ${text}`);
        return `Added: ${text}`;
      case "complete":
        todos[index!].done = true;
        return `Completed: ${todos[index!].text}`;
      case "remove":
        const [removed] = todos.splice(index!, 1);
        return `Removed: ${removed.text}`;
    }
  },
  render: () => (
    <Section id="todo-list" audience="model">
      <H2>Current Todos</H2>
      {todos.length === 0 ? (
        <Paragraph>No todos yet.</Paragraph>
      ) : (
        <List task>
          {todos.map((t) => (
            <ListItem checked={t.done}>{t.text}</ListItem>
          ))}
        </List>
      )}
    </Section>
  ),
});
```

## How It Works

1. `<TodoTool />` mounts into the fiber tree
2. The `render` function produces a `<Section>` that the compiler includes in model context
3. When the model calls `manage_todos`, the handler modifies state
4. On the next tick, the reconciler re-renders — the `<Section>` reflects updated state
5. The model sees current todos in its context

The key insight: **the tool's handler and render function share state**. The handler modifies it, the render function displays it. The reconciler bridges the gap.

## When to Use Stateful Tools

Use stateful tools when:

- A tool manages a collection (todos, notes, artifacts)
- The model needs to see current state to make good decisions
- State accumulates across multiple tool calls

Use plain tools when:

- The tool is a pure function (search, calculate, fetch)
- No state to display between calls
- The tool result alone is sufficient context

## Using ctx.setState

For state that should persist across the session (not just in-memory):

```tsx
handler: async ({ query }, ctx) => {
  const results = await search(query);
  ctx?.setState("searchHistory", [
    ...(ctx?.getState("searchHistory") ?? []),
    { query, resultCount: results.length, timestamp: Date.now() },
  ]);
  return results;
},
render: () => {
  const history = ctx?.getState("searchHistory") ?? [];
  return (
    <Section id="search-history">
      ## Recent Searches
      {history.map(h => `- "${h.query}" (${h.resultCount} results)`).join("\n")}
    </Section>
  );
},
```
