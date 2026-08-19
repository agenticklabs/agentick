# Agentick - Claude Code Guidelines

> # ⛔ READ THIS FIRST: WRITE READABLE CODE, NOT COMMENTARY
>
> **If code needs a long comment to be understood, the code is wrong. Fix the code.**
>
> Comments are for genuinely extenuating circumstances — a non-obvious constraint,
> a provider bug, an ordering requirement that reads as arbitrary. That is a small
> set. Everything else is a naming or structure problem wearing a comment as a
> disguise.
>
> **Before writing a comment, try in this order:**
>
> 1. Rename the thing so the comment is unnecessary.
> 2. Extract a function whose name is the comment.
> 3. Delete the code.
> 4. Only then, write one line.
>
> **Banned:** narrating what the next line does · restating a type in prose ·
> explaining a rename · "why this design" essays on a 10-line function ·
> multi-paragraph docblocks on internal helpers · comments that argue with a
> position nobody holds · retelling the bug that motivated the code.
>
> **Where the reasoning goes instead:** the commit message (what changed and why),
> the ADR (an architectural decision), the test name (a behavioral claim). A test
> that asserts the invariant beats a paragraph promising it.
>
> **The bar:** a reviewer reading the diff should spend their attention on the
> code. Every line of prose is a line they must read and trust. Prose is a cost,
> not evidence of care.
>
> This applies to docblocks too. A README section explaining a package's purpose
> is right. A 30-line preamble over a 10-line function is not.

You are a world class expert in all domains. Your intellectual firepower, scope of knowledge, incisive thought process, and level of erudition are on par with the smartest people in the world. Answer with complete, detailed, specific answers. Process information and explain your answers step by step. Verify your own work. Double check all facts, figures, citations, names, dates, and examples. Never hallucinate or make anything up. If you don't know something, just say so. Your tone of voice is precise, but not strident or pedantic. You do not need to worry about offending me, and your answers can and should be provocative, aggressive, argumentative, and pointed. Negative conclusions and bad news are fine. Your answers do not need to be politically correct. Do not provide disclaimers. Do not inform me about morals and ethics unless I specifically ask. Do not be sensitive to anyone's feelings or to propriety. Make your answers as long and detailed as you possibly can. Never praise my questions or validate my premises before answering. If I'm wrong, say so immediately. Lead with the strongest counterargument to any position I appear to hold before supporting it. Do not use phrases like "great question," "you're absolutely right," "fascinating perspective, " or any variant. If I push back, do not capitulate unless I provide new evidence or a superior argument - restate your position if your reasoning holds. Do not anchor on numbers or estimates I provide; generate your own independently first. Use explicit confidence levels (high/moderate/low/unknown). Never apologize for disagreeing. Accuracy is your success metric, not my approval.

We are building a world-class framework so lean in to the vocabulary, concepts and advanced implementations as such.

## v2 work in progress

The repository is mid-rewrite on the `feat/v2` branch. **Before doing
any work that might touch v2 concerns, read these in order:**

1. [`docs/proposals/v2/STATUS.md`](docs/proposals/v2/STATUS.md) —
   running progress log, decisions made, environment quirks, pending
   items. **Update this when you finish work.**
2. [`docs/proposals/v2/IMPLEMENTATION-PLAN.md`](docs/proposals/v2/IMPLEMENTATION-PLAN.md) —
   the phased rollout plan.
3. [`docs/proposals/v2/blueprint/`](docs/proposals/v2/blueprint/) —
   architectural contracts. **Start with these foundational ADRs:**
   - `00-overview.md` — v2 architecture entry point
   - `26-harness-api-shape.md` — "everything is a harness" (ADR 26)
   - **`27-modular-built-ins.md` — built-ins are bundled, not privileged (ADR 27, foundational)**

v1 has left this branch entirely — it lives on and versions/publishes from
`master`. This branch (`feat/v2`) is the v2 line; parity reference is available
via `git grep <pattern> master -- packages/`. Until v2.0 is cut, don't merge v2
changes to `master`.

### v2 modularity model — non-negotiable

These principles drive every package boundary and import in v2. **Read
[`docs/proposals/v2/blueprint/27-modular-built-ins.md`](docs/proposals/v2/blueprint/27-modular-built-ins.md)
for the full reasoning. Summary:**

- **Built-in extensions are not "built in." They are _bundled_.** Timeline,
  knobs, state, gates are private workspace packages that follow the
  same architectural pattern as optional extensions (sandbox, mcp). The
  metapackage (`agentick`) bundles the built-ins; optionals are
  separate npm installs. No code-level distinction between the two.
- **`HookBridges` in `@agentick/spec` is an empty seed.** Every harness
  package — built-in or optional — augments it via TypeScript module
  augmentation (`declare module "@agentick/spec"`). Spec does NOT
  hardcode foundational slots.
- **Per-harness package layout (the convention):**
  ```
  @agentick/<harness>/
    src/
      harness.ts                   — BaseHarness impl
      augment.ts                   — adds the HookBridges slot
      extension.ts                 — withX() session-extension factory
      conformance.ts               — runXHarnessConformance suite
      react/                       — optional React surface (hooks + components)
      testing/                     — optional stubXHarness factory
      __tests__/
        harness.spec.ts                       — harness-only tests
        integration-with-compiler.spec.tsx    — uses real CompilerHarness
  ```
- **`@agentick/compiler-react` has NO dependency on any harness
  package.** It owns the JSX → IR pipeline and the bridge context
  (`BridgeProvider` / `useBridges`); the reference `InMemoryDataBridge`
  lives in `@agentick/compiler`. Snapshot/restore iterates `HookBridges`
  generically via `SnapshotCapable` feature detection — no hardcoded
  slot names. Any harness can add a `/react` subpath that depends on
  compiler-react WITHOUT creating a cycle.
- **Tests live where their dependencies live.** A "knobs work with the
  compiler" test belongs in `@agentick/knobs/__tests__/`, not in
  compiler-react. Compiler-react's tests test the compiler
  ITSELF, using protocol mocks where bridges are needed. Cross-harness
  integration tests live in `@agentick/session` (which depends on all
  the harnesses it integrates) or in the public metapackage.
- **Shipping ≠ architecture.** Built-ins ship as private workspace
  packages bundled into the `agentick` metapackage. Optional extensions
  ship as public packages installed separately. The pattern at the
  code level is identical between them.

**If you find yourself wanting to special-case foundational harnesses
vs optional extensions, stop. The pattern is intentionally uniform.**
The asymmetry between them is purely a packaging concern.

## Philosophy

**No backwards compatibility, no deprecations, no legacy code paths.**

We are in a special window of opportunity to get the API right before users depend on it. Take advantage of this by making breaking changes freely when they improve the design.

When refactoring:

- Remove old code entirely rather than deprecating
- Don't add compatibility shims or migration helpers
- Don't keep unused exports "for backwards compat"
- One way to do things, done well

**Architecture over expediency.** Every architectural decision compounds. Take 20 minutes to think through the right abstraction boundary, the right package home, the right interface shape. A wrong architectural decision early means the project fails later. When in doubt, think about who else will need this, where the interface should live, and whether the dependency graph stays clean.

### Documentation

**Document features with README files at all levels of the codebase.**

- `packages/*/README.md` - Package overview and API
- `packages/*/src/*/README.md` - Submodule documentation
- Any directory with non-obvious patterns

README content: Purpose, Usage examples, API reference, Patterns.

### Primitives vs Patterns

The framework provides **building blocks**, not opinions.

| Primitive                      | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `<Timeline>`                   | Conversation history (IS the conversation — filter/compact/render)   |
| `<Tool>`                       | Function the model can call                                          |
| `<Section>`                    | Content rendered to model context                                    |
| `<Message>`                    | Message added to timeline                                            |
| Signals/hooks                  | Reactive state management                                            |
| Channels                       | Real-time sync between session and UI                                |
| `knob()`                       | Config-level knob descriptor (detected by `isKnob()`)                |
| `useKnob()`                    | Model-visible, model-settable reactive state                         |
| `<Knobs />`                    | Knob section + set_knob tool (default, render prop, or provider)     |
| `useTimeline()`                | Direct read/write access to session timeline                         |
| `useResolved()`                | Access resolve data on session restore (Layer 2)                     |
| `use()` on tools               | Bridge render-time context (React Context, hooks) into tool handlers |
| `<MCP>`                        | Connect to MCP servers (tools + progressive resource discovery)      |
| `<Sandbox>`                    | Sandboxed execution (provider-backed, tree-scoped tools)             |
| ExecutionRunner                | Controls how compiled context reaches model and how tools execute    |
| `exposure: ["dispatch"]` tools | Visibility: tool hidden from model, only reachable via dispatch      |
| `dispatch()`                   | Invoke any tool by name/alias without model involvement (Procedure)  |

#### Semantic Components (`packages/compiler-react/src/react/components/semantic.tsx`)

Use these instead of raw markdown strings in JSX. They compile to renderer-appropriate output.

| Component                           | Purpose                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `<H1>`–`<H3>`, `<Header level={n}>` | Headings                                                       |
| `<Paragraph>`                       | Paragraph block                                                |
| `<List>`                            | List container (`ordered`, `task` props)                       |
| `<ListItem>`                        | List item (`checked` prop for task lists)                      |
| `<Table>`                           | Table (`headers`/`rows` props, or `<Row>`/`<Column>` children) |
| `<Row>`, `<Column>`                 | Table row and column                                           |

#### Content Block Components (`packages/compiler-react/src/react/components/`)

Typed content blocks for composing rich message content:

| Component            | Purpose                              |
| -------------------- | ------------------------------------ |
| `<Text>`             | Text block (children or `text` prop) |
| `<Image>`            | Image (`source: MediaSource`)        |
| `<Code>`             | Code block (`language` prop)         |
| `<Json>`             | JSON data block (`data` prop)        |
| `<Document>`         | Document attachment                  |
| `<Audio>`, `<Video>` | Media blocks                         |

#### Message Role Components (`packages/compiler-react/src/react/components/semantic.tsx`)

| Component     | Purpose                                |
| ------------- | -------------------------------------- |
| `<System>`    | System prompt message                  |
| `<User>`      | User message                           |
| `<Assistant>` | Assistant message                      |
| `<Event>`     | Event entry — see event blocks below   |
| `<Grounding>` | Semantic wrapper for grounding context |

#### Events

The preferred authoring surface is the PascalCase components — position-aware
(via `MessageScopeContext`): at the top level each forms its own `event`-role
entry; inside any message it contributes just its block.

| Component       | Shape                                        |
| --------------- | -------------------------------------------- |
| `<SystemEvent>` | `event`, `source?`, `data?`                  |
| `<UserAction>`  | `action`, `actor?`, `target?`, `details?`    |
| `<StateChange>` | `entity`, `field?`, `from`, `to`, `trigger?` |

```tsx
<SystemEvent event="compaction" source="timeline" data={{ summary }} />

<Event>
  <SystemEvent event="job-sync" />
  <StateChange entity="job-113" field="status" from="draft" to="active" />
</Event>
```

Escape hatches: the underscored intrinsics (`<system_event>` etc. — the wire
records the components lower to, 1:1, non-colliding by construction);
`<Event key={entry.id} {...entry} />` for verbatim replay of a stored entry;
and the `text` field, which replaces the formatter-derived body — authoring
`text` by hand freezes a rendering into the durable timeline, so reach for it
only to override.

#### Application-defined tags

Any lowercase JSX tag containing a hyphen is the application's semantic tag
(the custom-elements rule): `<relevant-context source="rag">…</relevant-context>`
typechecks with zero declaration and lowers to a `<custom>` block in every
formatter. Single-word unknown tags stay reserved (typo safety +
wrapper-component passthrough). Content blocks are parents, never children —
a native block inside a custom tag's subtree drops with a `BLOCK_NOT_NESTABLE`
diagnostic; place it as a sibling.

#### Model selection

The model is a `createApp({ model })` option, overridable per send and per
tick via tree-declared model registrations (`useModelRegistration`, the
`<model-declaration>` intrinsic — ADR 56). Precedence: tick IR > send >
session. There are NO model JSX components: the `<Model>` sugar is deferred
(ADR 56 slice 1) and per-provider components (`<OpenAIModel>`, …) were
explicitly rejected.

**See `packages/compiler-react/README.md` for the complete JSX reference.**

Patterns (todos, artifacts, memory) are **state parallel to the timeline** - built by users from primitives.

### Stateful Tool Pattern

Recommended for managed collections. A tool has NO `render` option in v2 —
the handler mutates state (`ctx.setState` or a service), and a separate
component in the agent tree renders the model-visible view:

```tsx
export const MyStatefulTool = createTool({
  name: "my_tool",
  description: "...",
  input: schema,
  handler: async (input, { ctx }) => {
    const result = MyService.doAction(input);
    ctx.setState("lastResult", result);
    return [{ type: "text", text: "Done" }];
  },
});

export function MyStateSection() {
  return (
    <Section id="my-state">
      <H2>Current State</H2>
      <Json data={MyService.getState()} />
    </Section>
  );
}
```

### Dependency Injection into Tool Handlers (ADR 66)

Tool handlers run at **dispatch** time, separate from render. Two ways to reach what they need:

**`ctx` — dispatch-resolved (the default).** Session/app-scoped harnesses are typed slots on the handler `ctx`, resolved fresh at dispatch from the live bridge: `ctx.elicit`, `ctx.tasks`, `ctx.resource`, `ctx.tools` (dispatch sibling tools — same door and exposure gate as `session.tools`), `ctx.log`, `ctx.progress`, `ctx.sandbox`. Optional slots (sandbox, etc.) are contributed by their packages via module augmentation of `ToolHandlerCtxExtensions` — guard with `?`:

```typescript
const ShellTool = createTool({
  name: "shell",
  description: "Execute a command in the sandbox",
  input: z.object({ command: z.string() }),
  handler: async ({ command }, { ctx }) => {
    const sandbox = ctx.sandbox?.get("primary"); // dispatch-resolved from the live bridge
    if (!sandbox) return [{ type: "text", text: "no sandbox mounted" }];
    const result = await sandbox.exec(command);
    return [{ type: "text", text: result.stdout }];
  },
});
```

**`use()` — render-captured (the escape hatch).** For genuinely _tree-positional_ context — a value set by an ancestor provider, reachable only during render (a custom React Context). `use()` runs at render, captures from the component tree, and passes the result to the handler as `deps` (merged with `{ ctx }`). Reserve it for tree-positional context; session/app harnesses belong on `ctx`. Direct `.run()` calls get `undefined` deps.

The workspace is the v2 package tree under **`packages/`**. v1 lives on and
versions from `master`; this branch (`feat/v2`) is the v2 line.

### `packages/` — the v2 tree

```
Foundation:  spec · runtime · pubsub · utils
Compiler:    compiler (base) → compiler-react (JSX → IR harness)
Harnesses:   timeline · knobs · state · gates · tool · resources · elicitation ·
             tasks · prompts · skills · subscriptions · live · credentials
Executors:   tool-executor · model-executor · loop-executor
Model:       model · model-ai-sdk · model-anthropic · model-openai · model-google
Session/App: session · app
Client:      client-core → client · client-react · client-extensions
Wire:        transport(-http/-in-process/-unix-socket/-websocket) · gateway · cluster*
Optional:    sandbox* · mcp · connector · eval · formatters · store · telemetry-otlp
```

Every harness — built-in or optional — follows the per-harness layout in the v2 modularity model above. The naming law: `<role>` for a base, `<role>-<discriminator>` for a concrete impl.

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

### Execution Runner

An `ExecutionRunner` controls how compiled context is consumed and how tool calls execute. It's an optional `AppOptions` field — when omitted, the default behavior applies (model calls tools via tool_use protocol).

```typescript
const runner: ExecutionRunner = {
  name: "repl",
  transformCompiled(compiled, tools) { ... },   // Transform before model call
  executeToolCall(call, tool, next) { ... },    // Wrap tool execution
  onSessionInit(session) { ... },               // Once per session lifecycle
  onPersist(session, snapshot) { ... },         // Augment snapshot
  onRestore(session, snapshot) { ... },         // Restore runner state
  onDestroy(session) { ... },                   // Clean up resources
};

const app = createApp(MyAgent, { model, runner });
```

All methods are optional. The `transformCompiled` hook runs per-tick, `executeToolCall` runs per tool call, and lifecycle hooks run at session boundaries. Lifecycle hooks receive `SessionRef` (narrow: `id`, `status`, `currentTick`, `snapshot()`) — not the full `Session`.

Runners are inherited by spawned children. Use `SpawnOptions` (3rd arg to `session.spawn()`) to override:

```typescript
await session.spawn(Agent, { messages }, { runner: replRunner, model: cheapModel });
```

### React-like Reconciler

Agentick uses a React-inspired reconciler:

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
pnpm --filter @agentick/session test        # Run specific package
```

### Code Style

- **One code path**: No feature flags, no backwards compat shims
- **Clean imports**: Import from package index, not deep paths
- **Type inference**: Let TypeScript infer when obvious
- **No dead code**: Remove unused exports, functions, types
- **Errors over nulls**: Throw typed errors, don't return null for failures
- **Single source of truth for types**: Never define the same interface in multiple files

### New Package Checklist

When adding a new `@agentick/*` package, update all of these:

1. **Package setup**: `packages/my-package/` with `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`
2. **Versioning groups**: Add to `pnpm-workspace.yaml` — BOTH the fixed-version group array and the release-lane map (`"@agentick/my-package": next`). Miss either and the package does not version or publish with the rest.
3. **TypeDoc entry points**: Add to `website/typedoc.json` → `entryPoints` array
4. **Website package groups**: Add to `website/.vitepress/config.mts` → `PACKAGE_GROUPS` in the appropriate group
5. **README**: Create `packages/my-package/README.md` following the style of existing package READMEs (Purpose, Quick Start, API, Patterns)
6. **pnpm install**: Run `pnpm install` to register the workspace package

### Cross-Package Changes

When implementing a feature in one package, **don't treat code in other packages as static.** If modifying an underlying system (spec, runtime, compiler) would lead to a cleaner, more elegant solution — propose the change. Always confirm with the user before modifying interfaces or behavior in packages outside the one you're working in.

### Before Making Type Changes

1. Run `pnpm build` or `pnpm typecheck` first (not just tests)
2. Search for duplicate definitions: `grep -r "export.*interface MyType" packages/`
3. Choose one canonical source; have others re-export

### Check `@agentick/utils` Before Writing Utilities

Before writing ANY utility function, **always check `@agentick/utils` first**
(and its `/testing` subpath for test helpers). It is the canonical home for
cross-package utilities: `waitFor`, `waitForStable`, `isEqual`, `mergeLayered`,
`omitUndefined`, `generateId`, `resolveSync`, etc.

- **Before creating**: grep `packages/utils/src/` for the function name
- **Shared code belongs there**: if a utility will be used across multiple
  packages (connector, client, compiler, adapters), put it in utils
- **Re-exports are fine**: packages can re-export from utils for convenience,
  but the implementation must live in utils — not be duplicated

## File Locations

### v2 — `packages/`

| What                     | Where                                               |
| ------------------------ | --------------------------------------------------- |
| Protocol seam (spec)     | `packages/spec/src/`                                |
| Foundation (bus/journal) | `packages/runtime/src/`                             |
| JSX compiler harness     | `packages/compiler-react/src/`                      |
| Compiler base + collect  | `packages/compiler/src/`                            |
| Built-in harnesses       | `packages/<harness>/src/`                           |
| Session / App            | `packages/session/src/`, `packages/app/src/`        |
| Gateway / transports     | `packages/gateway/src/`, `packages/transport*/src/` |
| Client                   | `packages/client*/src/`                             |
| Tests                    | `packages/*/src/**/*.spec.ts`                       |
| Canonical example        | `example/v2-real/`                                  |
