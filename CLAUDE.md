# Tentickle - Claude Code Guidelines

## Philosophy

**No backwards compatibility, no deprecations, no legacy code paths.**

We are in a special window of opportunity to get the API right before users depend on it. Take advantage of this by making breaking changes freely when they improve the design.

When refactoring:

- Remove old code entirely rather than deprecating
- Don't add compatibility shims or migration helpers
- Don't keep unused exports "for backwards compat"
- One way to do things, done well

### Documentation

**Document features with README files at all levels of the codebase.**

- `packages/*/README.md` - Package overview and API
- `packages/*/src/*/README.md` - Submodule documentation
- Any directory with non-obvious patterns

README content: Purpose, Usage examples, API reference, Patterns.

### Primitives vs Patterns

The framework provides **building blocks**, not opinions.

| Primitive     | Purpose                                    |
| ------------- | ------------------------------------------ |
| `<Timeline>`  | Conversation history (IS the conversation) |
| `<Tool>`      | Function the model can call                |
| `<Section>`   | Content rendered to model context          |
| `<Message>`   | Message added to timeline                  |
| Signals/hooks | Reactive state management                  |
| Channels      | Real-time sync between session and UI      |

Patterns (todos, artifacts, memory) are **state parallel to the timeline** - built by users from primitives.

### Stateful Tool Pattern

Recommended for managed collections (see `example/express/src/tools/todo-list.tool.tsx`):

```typescript
export const MyStatefulTool = createTool({
  name: "my_tool",
  description: "...",
  input: schema,
  handler: async (input) => {
    const result = MyService.doAction(input);
    const ctx = Context.tryGet();
    ctx?.channels?.publish(ctx, "my-channel", { type: "state_changed", payload: result });
    return [{ type: "text", text: "Done" }];
  },
  render: () => (
    <Section id="my-state" audience="model">
      Current state: {JSON.stringify(MyService.getState())}
    </Section>
  ),
});
```

## Package Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Applications                                │
│        (example/express, user apps, CLI tools)                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                          Framework Layer                                 │
│   @tentickle/core     @tentickle/gateway     @tentickle/client          │
│   @tentickle/express  @tentickle/devtools                               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                         Adapter Layer                                    │
│   @tentickle/openai   @tentickle/google   @tentickle/ai-sdk             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                        Foundation Layer                                  │
│              @tentickle/kernel          @tentickle/shared               │
│              (Node.js only)             (Platform-independent)          │
└─────────────────────────────────────────────────────────────────────────┘
```

See individual package READMEs for detailed documentation.

## Core Concepts

### Session & Execution Model

**Session**: Long-lived conversation context with state persistence.
**Execution**: Single run (one user message → model response cycle).
**Tick**: One model API call. Multi-tick executions happen with tool use.

```
Session
├── Execution 1 (user: "Hello")
│   └── Tick 1 → model response
├── Execution 2 (user: "Use calculator")
│   ├── Tick 1 → tool_use (calculator)
│   └── Tick 2 → final response
└── Execution 3 ...
```

### React-like Reconciler

Tentickle uses a React-inspired reconciler:

- **Fiber Tree**: Virtual DOM-like component hierarchy
- **Reconciler**: Component lifecycle, diffs, scheduling
- **Compiler**: Transforms fiber tree → model-ready format

```
User JSX → Fiber Tree → CompiledStructure → Provider Input
```

## Development Practices

### Commands

```bash
pnpm test                                   # Run all tests
pnpm build                                  # Build all packages
pnpm typecheck                              # Check all types
pnpm --filter @tentickle/core test          # Run specific package
```

### Code Style

- **One code path**: No feature flags, no backwards compat shims
- **Clean imports**: Import from package index, not deep paths
- **Type inference**: Let TypeScript infer when obvious
- **No dead code**: Remove unused exports, functions, types
- **Errors over nulls**: Throw typed errors, don't return null for failures
- **Single source of truth for types**: Never define the same interface in multiple files

### Before Making Type Changes

1. Run `pnpm build` or `pnpm typecheck` first (not just tests)
2. Search for duplicate definitions: `grep -r "export.*interface MyType" packages/`
3. Choose one canonical source; have others re-export

## Common Patterns

### Adding a Gateway Method

```typescript
methods: {
  namespace: {
    methodName: method({
      schema: z.object({ /* params */ }),
      handler: async (params) => {
        const ctx = Context.get();
        return { result: "value" };
      },
    }),
  },
}
```

### Creating a Procedure

```typescript
import { createProcedure } from "@tentickle/kernel";

export const myProcedure = createProcedure(
  { name: "my-procedure", schema: z.object({ input: z.string() }) },
  async (params) => ({ output: params.input.toUpperCase() })
);
```

### Using ALS Context

```typescript
import { Context } from "@tentickle/kernel";

const ctx = Context.get();
const userId = ctx.user?.id;
Context.emit("custom:event", { data: "value" });
```

## File Locations

| What              | Where                           |
| ----------------- | ------------------------------- |
| Kernel primitives | `packages/kernel/src/`          |
| Shared types      | `packages/shared/src/`          |
| Core reconciler   | `packages/core/src/reconciler/` |
| Built-in JSX      | `packages/core/src/jsx/`        |
| Hooks             | `packages/core/src/hooks/`      |
| Gateway           | `packages/gateway/src/`         |
| Client            | `packages/client/src/`          |
| Express example   | `example/express/src/`          |
| Tests             | `packages/*/src/**/*.spec.ts`   |

## Model Adapters

See `packages/adapters/README.md` for comprehensive adapter documentation.

Key points:

- Use `createAdapter()` which returns a `ModelClass` (callable + JSX component)
- Implement `prepareInput`, `mapChunk`, `execute`, `executeStream`
- Handle provider-specific streaming quirks (OpenAI sends usage separately)
- `mapChunk` returns `AdapterDelta` or `null` to ignore chunks

## Common Debugging

### Component shows as `<Unknown>` in DevTools

Add `displayName` to function components.

### System tokens showing as 0

Check that `<System>` or `<section>` components are in the tree.

### Fiber tree not updating

Snapshots taken at tick end. Check `tick_end` events are being emitted.

### DevTools not receiving events

1. Verify `devTools: true` in app config
2. Check SSE connection in Network tab
3. Look for `[DevTools]` log messages

### CSS: Flex children overflowing viewport

```css
.container {
  height: 100vh;       /* Fixed height, not min-height */
  overflow: hidden;
}
.child {
  flex: 1;
  min-height: 0;       /* Critical! Allows shrinking */
  overflow: auto;
}
```
