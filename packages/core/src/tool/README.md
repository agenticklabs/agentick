# Agentick Tools

Tools are the bridge between LLM reasoning and real-world actions. They define what actions the model can take.

## Creating Tools

Use `createTool` to create tools with type-safe schemas:

```typescript
import { createTool } from '@agentick/core';
import { z } from 'zod';

const SearchTool = createTool({
  name: 'search',
  description: 'Search the knowledge base',
  input: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(10),
  }),
  handler: async ({ query, limit }) => {
    const results = await db.search(query, limit);
    return [{ type: 'text', text: JSON.stringify(results) }];
  },
});
```

## COM in Handlers

Tool handlers receive an optional `ctx` (Context Object Model) as their second argument. During agent execution (when the model calls the tool), `ctx` is provided. When calling directly via `MyTool.run(input)`, `ctx` is undefined.

```typescript
const StatefulTool = createTool({
  name: 'update_preferences',
  description: 'Update user preferences',
  input: z.object({ key: z.string(), value: z.string() }),
  handler: async ({ key, value }, ctx) => {
    // ctx is available during agent execution
    ctx?.setState(key, value);
    return [{ type: 'text', text: `Set ${key}=${value}` }];
  },
});
```

## The ToolClass Pattern

`createTool` returns a `ToolClass` - usable both as JSX and programmatically:

```typescript
// As JSX component (registers tool when mounted)
function MyAgent() {
  return (
    <>
      <SearchTool />
      <Timeline />
    </>
  );
}

// Direct execution
const result = await SearchTool.run({ query: 'hello' });

// Pass to engine
engine.execute({ tools: [SearchTool] });
```

## Execution Types

| Type       | Description                           |
| ---------- | ------------------------------------- |
| `SERVER`   | Executes on server (default)          |
| `CLIENT`   | Executes in browser, result sent back |
| `PROVIDER` | Handled by model provider             |
| `MCP`      | Routed to MCP server                  |

```typescript
import { ToolExecutionType, ToolIntent } from '@agentick/core';

const ChartTool = createTool({
  name: 'render_chart',
  description: 'Display a chart',
  type: ToolExecutionType.CLIENT,
  intent: ToolIntent.RENDER,
  requiresResponse: false,
  input: z.object({
    type: z.enum(['bar', 'line', 'pie']),
    data: z.array(z.object({ label: z.string(), value: z.number() })),
  }),
});
```

## Rendering State

Tools can render content to the model's context using the `render` function:

```typescript
const TodoTool = createTool({
  name: 'todo',
  description: 'Manage todos',
  input: z.object({ action: z.enum(['add', 'remove', 'list']) }),
  handler: async ({ action }) => { /* ... */ },

  // Render current state to model context each tick
  render: (tickState, ctx) => (
    <Section id="todos">
      Current todos: {JSON.stringify(todoService.list())}
    </Section>
  ),
});
```

## Confirmation

Require user confirmation before execution:

```typescript
const DeleteTool = createTool({
  name: 'delete_file',
  description: 'Delete a file',
  input: z.object({ path: z.string() }),
  requiresConfirmation: true,
  confirmationMessage: (input) => `Delete "${input.path}"?`,
  handler: async ({ path }) => { /* ... */ },
});
```

## Lifecycle Hooks

Tools support lifecycle hooks for JSX usage. All hooks follow the "data first, COM last" pattern:

```typescript
const MyTool = createTool({
  name: 'my_tool',
  // ...
  onMount: (ctx) => console.log('Tool mounted'),
  onUnmount: (ctx) => console.log('Tool unmounted'),
  onTickStart: (tickState, ctx) => { /* before each tick */ },
  onTickEnd: (result, ctx) => { /* after each tick */ },
});
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation on:

- Tool definition internals
- Execution routing
- Hook system
- Provider options
