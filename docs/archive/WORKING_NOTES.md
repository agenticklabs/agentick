# Working Notes

## Brainstorm: `useToolResult` Hook

**Idea:** A reactive subscriber to tool execution results. The model calls the tool normally; any mounted component can subscribe to get the result.

```tsx
function RelatedKnowledge({ query }: { query: string }) {
  const results = useToolResult(KnowledgeTool, [query]);
  return (
    <Section id="related-knowledge" audience="model">
      {results?.map((block) => block.text).join("\n")}
    </Section>
  );
}
```

**How it differs from existing patterns:**

- NOT auto-invoking the tool — the model calls it when it wants
- Decouples tool execution from result rendering (unlike `render` on the tool)
- Eliminates manual `com.setState` in handler + read state elsewhere boilerplate

### Open Design Questions

1. **Return shape:** Raw `ContentBlock[]`? Or support a selector/transform?
2. **Multiple calls per tick:** Last result only? All accumulated since deps changed?
3. **Implementation path:** COM state convention? Signals? Dedicated subscription system?
4. **Cache invalidation:** What triggers re-render — tool called, or deps changing?
5. **Relationship to `useData`:** Key difference is `useData` auto-invokes; `useToolResult` passively subscribes.

---

## WARTS Deep Dive & Proposals

### #1. COM Naming → `ctx`

**User feedback:** Loves it. Concern about confusion with ALS `Context`.

**Analysis:** The ALS `Context` (`Context.get()`) and the COM parameter serve different purposes:

- `Context` (ALS) = request-scoped container (user, session, connection info)
- `com`/`ctx` = component-scoped model interface (setState, channels, tools)

**Risk assessment:** Low. They operate at different levels. `Context.get()` is a static call; `ctx` would be a callback parameter. The naming collision with React's `useContext` is more concerning but also fine — React users already distinguish between `context` (React) and `ctx` (app-specific).

**Decision needed:** Rename `com` parameter → `ctx` everywhere? Or keep `com` with better docs?

---

### #2. Three Input Types → Progressive Disclosure

**User feedback:** This is big. Remember: `run()` = implicit app + implicit session, `app.run()` = explicit app + implicit session, `session.send()` = explicit app + explicit session.

**Current state:**

```
RunInput<P>   = { model?, props?, messages?, history?, maxTicks?, signal? }
SendInput<P>  = { messages?, props?, metadata?, maxTicks?, signal? }
```

**Call chain:**

1. `run(element, RunInput)` → merges element props → `app.run(RunInput)` → `session.render(props)`
2. `app.run(RunInput)` → creates session → queues messages via `session.queue.exec()` → `session.render(props)`
3. `session.send(SendInput)` → queues messages → if idle, calls `session.render(props)`

**Proposed unified shape:**

```typescript
// Base: common to all levels
interface BaseInput<P> {
  props?: P;
  messages?: Message[]; // Always array, no discriminated union
  metadata?: Record<string, unknown>;
}

// Level 1: run() adds model + execution control
interface RunInput<P> extends BaseInput<P> {
  model?: ModelInstance;
  history?: TimelineEntry[];
  maxTicks?: number;
  signal?: AbortSignal;
}

// Level 2: app.run() adds session options
interface AppInput<P> extends BaseInput<P> {
  history?: TimelineEntry[];
  options?: SessionOptions; // No Omit wrapper
}

// Level 3: session.send() is pure message delivery
type SendInput<P> = BaseInput<P>;

// Execution options are a separate concern, passed as 2nd arg
interface ExecutionOptions {
  maxTicks?: number;
  signal?: AbortSignal;
}
```

**Key changes:**

- Kill the `message | messages` discriminated union in SendInput — just `messages: Message[]`
- `metadata` available at all levels (currently only SendInput)
- `history` is a setup concern (Level 1+2), not a per-message concern
- Execution control (`maxTicks`, `signal`) is always a separate `ExecutionOptions` arg

**Migration path:** Since "no backwards compat" — just change it.

---

### #3. `tick()` → `render()`

**User feedback:** Loves `render()` proposal. `tick()` was for getting data in without necessarily triggering model execution.

**Research findings:**

- `tick(props)` DOES trigger model execution (starts the full tick loop)
- `send()` delegates to `tick()` after queuing messages
- `tick()` returns `SessionExecutionHandle` (same as send)

**Proposal:**

```typescript
interface Session<P> {
  send(input: SendInput<P>, options?: ExecutionOptions): SessionExecutionHandle;
  render(props: P, options?: ExecutionOptions): SessionExecutionHandle; // was tick()
  queue: Procedure<(message: Message) => Promise<void>>;
  close(): void;
}
```

`render()` communicates: "re-render the component tree with these props and run the tick loop." It's what it actually does — compiles JSX with new props, then runs model if there's work.

**If we want props-only without model execution** (the original tick intent), that's a different method entirely — maybe `update(props)` that just re-renders without running the model. But that might be YAGNI.

---

### #4. Procedure Documentation

**User feedback:** Should live in kernel package. Prominent but below the fold. Procedures & Middleware & Observability section.

**Action items:**

- Write `packages/kernel/README.md` section on Procedures
- Add to CLAUDE.md as a reference section
- Cover: what a Procedure is, `.use()`, `.withContext()`, `ProcedurePromise` auto-unwrap, `ExecutionHandle`
- Explain when users encounter Procedures (app.run, tool.run, queue) vs plain methods

---

### #5. Model Type Cleanup

**User feedback:** Get rid of `EngineModel` (Engine is gone). Rename `createEngineProcedure` → `createProcedure`. Consider `createAdapter` → `createModel`. Note Message type/component clash.

**Current type hierarchy:**

```
EngineModel  ← the actual interface (generate, stream, metadata)
ModelInstance = EngineModel  ← pointless alias, DELETE
ModelClass extends EngineModel  ← adds JSX callability
```

**Proposed:**

```
Model        ← rename from EngineModel (Engine is gone)
ModelClass extends Model  ← or just call this Model too?
```

**The naming problem:** If we call the type `Model`, it clashes with the `<Model>` JSX component (just like `Message` type vs `<Message>` component). Current solution for Message was `ModelMessage` type alias.

**Options:**

1. `Model` type + `<Model>` component — accept the clash, alias as needed
2. `ModelInterface` type + `<Model>` component — ugly but unambiguous
3. Keep `ModelClass` for the callable type — it's actually descriptive (class = callable + has statics)

**`createAdapter` → `createModel`?** It does create a model. But "adapter" communicates that you're adapting a provider's API. `createModel` sounds like you're creating a model from scratch. Maybe keep `createAdapter`.

**`createEngineProcedure` → `createProcedure`:** Yes. Engine doesn't exist. This is just "create a procedure with standard middleware."

**Action:** Delete `ModelInstance` alias. Rename `EngineModel` → something. Rename `createEngineProcedure`.

---

### #6. Exports Inventory

**Research findings:**

- `createAdapter` and `ModelClass` are NOT exported from `@agentick/core` index
- Adapter packages use deep imports: `@agentick/core/model`, `@agentick/core/utils`, `@agentick/core/tool`
- No adapter package has `exports` field in package.json

**Action items:**

- Audit `packages/core/src/index.ts` — what should be public API?
- Re-export `createAdapter`, `ModelClass`, `normalizeModelInput` from core
- Add `exports` to all adapter package.json files
- Consider what else adapter authors need

---

### #7. ~~Delete All Deprecations~~ — RESOLVED

All 15+ @deprecated markers deleted. Zero `@deprecated` markers remain in `packages/`.

---

### #8. ~~`reason` vs `terminationReason`~~ — RESOLVED

`terminationReason` deleted from `COMStopRequest`, `COMControlRequest`, renamed to `reason` in `COMTickDecision`.

---

### #9. Lifecycle Hooks Skip Tick 1 — useLayoutEffect Proposal

**User feedback:** Loves the proposal. We don't have UI thread constraints. Need hooks to support async work and block the tick loop.

**Research findings:**

Current flow (useEffect):

```
notifyTickStart()  →  compile (useEffect runs, hooks register)  →  too late for tick 1!
```

With useLayoutEffect:

```
compile  →  useLayoutEffect fires synchronously  →  hooks registered  →  notifyTickStart works!
```

**Key insight from research:** The registration itself is synchronous (adding callback to a Set). The callbacks themselves CAN be async (they're `await`ed in `storeRunTickStartCallbacks`). So useLayoutEffect works perfectly:

```typescript
// Registration is sync (useLayoutEffect body)
useLayoutEffect(() => {
  store.tickStartCallbacks.add(cb);
  return () => store.tickStartCallbacks.delete(cb);
}, [store]);

// Execution is async (notifyTickStart awaits each callback)
for (const callback of store.tickStartCallbacks) {
  await callback(tickState, com); // async callbacks work fine
}
```

**Concerns:**

- useLayoutEffect is "for DOM measurements" in React semantics — but we have no DOM
- React warns about useLayoutEffect in SSR — might need to check reconciler behavior
- Slightly blocks rendering, but our "rendering" is just building a data structure, not painting pixels

**Proposal:** Switch all lifecycle hook registrations from `useEffect` to `useLayoutEffect`. This:

- Fixes tick 1 problem
- Registration is still sync (just adding to a Set)
- Callbacks can still be async (awaited at call site)
- No DOM concerns since we're not in a browser

**One concern:** The compile → notify flow might need adjustment. Currently:

1. `notifyTickStart()`
2. `compile()` (effects fire here)
3. Model call
4. `notifyTickEnd()`

If hooks register during compile via useLayoutEffect, `notifyTickStart` still fires BEFORE compile. So we may also need to **move notifyTickStart to after compile** OR do a two-phase approach: register hooks during compile, then fire tick-start.

**Needs investigation:** Exact ordering of `notifyTickStart` vs `compile` in the session tick loop.

---

### #10. Compiler Internals

**Research findings:** `getActiveCompiler`, `isCompilerRendering`, `shouldSkipRecompile`, `setActiveCompiler` are exported from `packages/core/src/compiler/index.ts`.

Only used internally by `packages/core/src/hooks/signal.ts` for signal effect tracking. NOT used by devtools or any other package.

**Action:** Move to a `compiler/internals.ts` or don't export from the package index. These are implementation details of the signal system.

---

### #11. ~~agentickComponent (Class Components)~~ — RESOLVED

Deleted `agentick-component.tsx`, its test, all exports, and "Class Components" doc section.

---

### #12. ~~`onAfterCompile` Dead `ctx` Parameter~~ — RESOLVED

Signature fixed to `(compiled, com)` matching hook convention. Bridge code uses `hookCom` from callback.

---

### #13. Adapter Inconsistencies — **RESOLVED**

**User feedback:** Need consistency. Clarify provider vs library adapter distinction.

**Resolution:** Dead type aliases deleted, `aiSdk()` return type standardized to `ModelClass`. Most "inconsistencies" below are intentional Provider vs Library architecture. See WARTS.md #13.

**Research found these inconsistencies (pre-fix):**

| Issue                     | OpenAI                  | Google                             | AI SDK                     |
| ------------------------- | ----------------------- | ---------------------------------- | -------------------------- |
| Return type alias         | `OpenAIAdapter`         | `GoogleAdapter`                    | `AiSdkAdapter`             |
| JSX wrapper               | `OpenAIModel`           | `GoogleModel`                      | None                       |
| `config.model`            | Optional                | Optional                           | **Required**               |
| Tool mapper name          | `mapToolDefinition`     | `mapToolDefinition`                | `convertToolsToToolSet`    |
| Module augmentation       | `ProviderClientOptions` | `ProviderClientOptions`            | `LibraryGenerationOptions` |
| Error types               | `AdapterError`          | `AdapterError` + `ValidationError` | None                       |
| `exports` in package.json | Missing                 | Missing                            | Missing                    |

**The Provider vs Library distinction IS intentional:**

- Provider adapter: agentick → Provider API (OpenAI, Google)
- Library adapter: agentick → Library → Provider API (AI SDK)

This should be documented. The naming difference (`ProviderClientOptions` vs `LibraryGenerationOptions`) makes sense architecturally but confuses users.

**Standardization proposal:**

1. All convenience factories return `ModelClass` directly (drop the aliases)
2. Standardize tool mapping to `mapToolDefinitions` (plural)
3. All adapters get `exports` in package.json
4. Google should use `AdapterError` consistently
5. Document the Provider vs Library adapter pattern in `packages/adapters/README.md`
6. AI SDK should provide a JSX wrapper for consistency

---

### Gateway / Server / CLI — Unimplemented Features

Consolidated from inline TODOs (deleted from source). These are real incomplete features, not stale code.

**Abort support:**

- `gateway.ts:handleAbortEndpoint` — HTTP abort endpoint returns `{ ok: true }` but doesn't actually abort
- `gateway.ts:handleAbortMethod` — RPC abort handler has session lookup but no abort call

**Persistence:**

- `gateway.ts:handleHistoryMethod` — Returns `{ messages: [], hasMore: false }` — needs persistence layer
- `session-manager.ts:resetSession` — Doesn't clear persisted history (no persistence layer)

**Channel integration:**

- `gateway.ts:createChannelContext` — `send()` generator yields `message_end` immediately without actually sending
- `http-transport.ts:handleChannelEndpoint` — Returns `{ ok: true }` without channel handling

**JWT auth:**

- `websocket-server.ts:authenticateClient` — JWT branch returns `{ valid: false }`
- `server/auth.ts:validateAuth` — JWT branch returns `{ valid: false }`

**CLI:**

- `cli/commands/status.ts` — Shows config but doesn't query server for actual status

---

### #15. TODO/FIXME Inventory

**Research found 12 TODOs in source code:**

**Core (4):**

- `mcp/client.ts:60` — inspect error for reconnection strategy
- `engine/tool-executor.ts:234` — proper parallel execution
- `engine/execution-handle.ts:570` — track phase in error
- `compiler/types.ts:22` — rename to `systemEntries`

**Gateway (5):**

- `gateway.ts:886, 1589` — implement abort
- `gateway.ts:1617` — history retrieval from persistence
- `gateway.ts:1708` — session send for channel context
- `websocket-server.ts:288` — JWT validation

**Server (1):**

- `auth.ts:85` — JWT validation

**HTTP Transport (1):**

- `http-transport.ts:554` — channel handling

**Session Manager (1):**

- `session-manager.ts:178` — clear persisted history

**Proposal:** Convert these to GitHub issues or a ROADMAP.md. Delete the inline TODOs. They're invisible in the code.

---

### #17. `queue` Is a Procedure, `send`/`tick` Are Not

**User feedback:** Surely send() and tick() (or render()) should be Procedures! Are they under the hood?

**Research findings:**

- `app.run` IS a Procedure (created via `createProcedure`)
- `session.queue` IS a Procedure
- `session.send()` and `session.render()` are PLAIN METHODS

**Why they're not Procedures:**

- Concurrent idempotency: multiple `send()` calls return THE SAME handle
- Hot-update: `render()` updates props on running sessions
- These semantics are hard to express as Procedure return values

**But middleware would be valuable for:**

- Observability (log every send/render)
- Rate limiting
- Context propagation

**Proposal:** Either:

1. Make `send`/`render` Procedures with special handling for idempotency
2. Keep them as methods but wrap the internal `executeTick()` call as a Procedure
3. Add middleware at the `app.run()` level only (already a Procedure)

Option 2 seems cleanest — the public API stays simple, but the internal execution path gets middleware support.
