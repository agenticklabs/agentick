# Agentick

React, but the render target is model context instead of DOM. Build AI applications with the tools you already know.

This is a monorepo using pnpm workspaces. The project uses the actual `react-reconciler` package — components, hooks, JSX, and the fiber tree all work like React. The difference is the compile target: instead of DOM elements, the reconciler produces structured context for language models.

## Build & Test

```bash
pnpm install                              # Install all dependencies
pnpm build                                # Build all packages
pnpm typecheck                            # TypeScript type checking
pnpm test                                 # Run all tests (vitest)
pnpm --filter @agentick/core test         # Test a specific package
pnpm --filter @agentick/kernel typecheck  # Typecheck a specific package
```

Always run `pnpm typecheck` after modifying interfaces or types. Structural typing means changes propagate through anonymous object literals — grep for property names, not just type names.

## Package Architecture

```
Applications (example/express, user apps)
    ↓
Framework: @agentick/core, gateway, client, express, devtools, agent
    ↓
Adapters: @agentick/openai, google, ai-sdk
    ↓
Foundation: @agentick/kernel (Node.js), @agentick/shared (universal)
```

**Core**

| Package | Path | Purpose |
|---------|------|---------|
| `agentick` | `packages/agentick` | Convenience re-export of @agentick/core |
| `@agentick/core` | `packages/core` | Reconciler, hooks, JSX, compiler, session, app |
| `@agentick/kernel` | `packages/kernel` | Procedures, execution tracking, ALS context |
| `@agentick/shared` | `packages/shared` | Wire-safe types, blocks, messages, streaming |

**Agent**

| Package | Path | Purpose |
|---------|------|---------|
| `@agentick/agent` | `packages/agent` | High-level createAgent factory |
| `@agentick/guardrails` | `packages/guardrails` | Guard system |

**Adapters**

| Package | Path | Purpose |
|---------|------|---------|
| `@agentick/openai` | `packages/adapters/openai` | OpenAI adapter |
| `@agentick/google` | `packages/adapters/google` | Google Gemini adapter |
| `@agentick/ai-sdk` | `packages/adapters/ai-sdk` | Vercel AI SDK adapter |

**Server**

| Package | Path | Purpose |
|---------|------|---------|
| `@agentick/gateway` | `packages/gateway` | Multi-session management, methods |
| `@agentick/server` | `packages/server` | Transport server (SSE, WebSocket) |
| `@agentick/express` | `packages/express` | Express.js integration |
| `@agentick/nestjs` | `packages/nestjs` | NestJS module |

**Client**

| Package | Path | Purpose |
|---------|------|---------|
| `@agentick/client` | `packages/client` | Browser/Node client for real-time sessions |
| `@agentick/react` | `packages/react` | React hooks & UI components |
| `@agentick/angular` | `packages/angular` | Angular services & utilities |
| `@agentick/cli` | `packages/cli` | Terminal client for agents |
| `@agentick/client-multiplexer` | `packages/client-multiplexer` | Multi-tab connection multiplexer |

**DevTools**

| Package | Path | Purpose |
|---------|------|---------|
| `@agentick/devtools` | `packages/devtools` | Fiber inspector, timeline viewer |

## Core Concepts

**Session**: Long-lived conversation context with state persistence.
**Execution**: One user message → model response cycle.
**Tick**: One model API call. Multi-tick executions happen when the model uses tools.

**Procedure**: Wraps any async function with middleware, execution tracking, and `ProcedurePromise`. Every model call, tool run, and engine operation is a Procedure. `await proc()` gives an ExecutionHandle; `await proc().result` gives the final value.

**Reconciler**: Components define what the model sees. The reconciler diffs the fiber tree between ticks. The compiler transforms it into model-ready format.

```
User JSX → Fiber Tree → CompiledStructure → Provider Input
```

## Key APIs

### Creating an App

```tsx
import { createApp } from "agentick";
import { OpenAIModel } from "@agentick/openai";

const app = createApp(() => (
  <>
    <OpenAIModel model="gpt-4o" />
    <System>You are helpful.</System>
    <Timeline />
  </>
));
```

### Creating a Tool

```tsx
import { createTool } from "agentick";

const SearchTool = createTool({
  name: "search",
  description: "Search the web",
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => { /* ... */ },
});
// Use as JSX: <SearchTool />
// Or call directly: SearchTool.run({ query: "test" })
```

### Model Adapters

| Import | Usage |
|--------|-------|
| `import { openai } from "@agentick/openai"` | Factory: `openai({ model: "gpt-4o" })` → ModelClass |
| `import { OpenAIModel } from "@agentick/openai"` | JSX: `<OpenAIModel model="gpt-4o" />` |
| `import { google } from "@agentick/google"` | Factory: `google({ model: "gemini-2.0-flash" })` |
| `import { GoogleModel } from "@agentick/google"` | JSX: `<GoogleModel model="gemini-2.0-flash" />` |

Best practice: declare the model as a JSX component in the tree (makes it dynamic/conditional).

### Hooks

| Hook | Signature | When |
|------|-----------|------|
| `useOnMount` | `(ctx) => void` | First tick only |
| `useOnTickStart` | `(tickState, ctx) => void` | Tick 2+ (after mount) |
| `useOnTickEnd` | `(result, ctx) => void` | Every tick end |
| `useAfterCompile` | `(compiled, ctx) => void` | After each compile |
| `useContinuation` | `(result, ctx) => boolean` | Control multi-turn |
| `useOnMessage` | `(message, ctx, state) => void` | On each message |
| `useKnob` | `(name, default, opts?) => [value, setter]` | Model-visible reactive state |

### JSX Components

**Structural**: `<System>`, `<Section>`, `<Tool>`, `<Timeline>`, `<Message>`, `<Knobs>`

**Semantic** (`packages/core/src/jsx/components/semantic.tsx`):
`<H1>`–`<H3>`, `<Header>`, `<Paragraph>`, `<List>`, `<ListItem>`, `<Table>`, `<Row>`, `<Column>`

**Content** (`packages/core/src/jsx/components/content.tsx`):
`<Text>`, `<Image>`, `<Code>`, `<Json>`, `<Document>`, `<Audio>`, `<Video>`

**Messages** (`packages/core/src/jsx/components/messages.tsx`):
`<System>`, `<User>`, `<Assistant>`, `<Event>`, `<Ephemeral>`, `<Grounding>`

Use semantic components instead of raw markdown strings in JSX.

### Session Procedures

`session.send`, `session.render`, `session.queue`, and `app.run` are all Procedures.

```tsx
const handle = await session.send({ messages: [...] });        // ExecutionHandle
const result = await session.send({ messages: [...] }).result;  // SendResult
```

## Coding Standards

- No backwards compatibility, no deprecations, no legacy code paths
- Import from package index, not deep paths
- Let TypeScript infer types when obvious
- Remove unused exports, functions, types immediately
- Throw typed errors, don't return null for failures
- Single source of truth for types — one canonical definition, re-export elsewhere
- Use semantic JSX components in examples, not raw strings

## File Locations

| What | Where |
|------|-------|
| Kernel primitives | `packages/kernel/src/` |
| Shared types | `packages/shared/src/` |
| Core reconciler | `packages/core/src/reconciler/` |
| Built-in JSX | `packages/core/src/jsx/` |
| Hooks | `packages/core/src/hooks/` |
| Compiler | `packages/core/src/compiler/` |
| Session & App | `packages/core/src/app/` |
| Tools | `packages/core/src/tool/` |
| Model abstraction | `packages/core/src/model/` |
| Testing utilities | `packages/core/src/testing/` |
| Tests | `packages/*/src/**/*.spec.ts` |
| Website | `website/` |
| Examples | `example/` |

## Testing

```tsx
import { createTestAdapter } from "@agentick/core/testing";

const adapter = createTestAdapter({ defaultResponse: "Hello!" });
adapter.respondWith([{ tool: { name: "search", input: { q: "test" } } }]);
```

See `packages/core/src/testing/` for `createMockApp`, `createMockSession`, and `createTestProcedure`.
