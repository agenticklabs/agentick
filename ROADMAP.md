# Roadmap

Agentick is a framework for building agentic LLM applications — agents, pipelines, RAG systems, chatbots, structured extraction, multi-step workflows. Not all applications are agents. The framework provides primitives; applications compose them.

This roadmap covers the **framework itself**. Ecosystem packages (tools, memory, connectors) and applications (personal assistant, coding agent) are separate projects that drive framework requirements back upstream.

---

## Framework Primitives

### Phase 1: spawn()

The one missing primitive. Sessions can't compose today — a session can't delegate work to another session. `spawn()` fixes that.

```typescript
session.spawn(agentOrConfig, input): ProcedurePromise<SessionExecutionHandle>
```

- Blocking by default (parent waits for child completion)
- Parallel spawns run concurrently
- Fire-and-forget is opt-in
- Child inherits middleware, not state/timeline/knobs
- Session gains `parent` and `children` references
- Spawn is a Procedure (middleware-aware, execution-tracked)
- **Parent context access** — spawned children can search/read parent's timeline and state via tool/command without paying for full context every tick

Design specified in `plans/spawn.md`. Implementation is session-layer work — `spawn` becomes a Procedure like `send` and `render`.

**What this unlocks for the framework:** Session composition. Any agentic app that needs task decomposition, multi-model orchestration, or sub-agent delegation. This isn't agent-specific — a RAG pipeline can spawn a retrieval step and a synthesis step.

---

### Near-term: fork()

Where `spawn()` creates a fresh child session, `fork()` creates a branch that **inherits** the parent's state — tools, timeline, knobs, context. Think of it as `git branch` for sessions.

```typescript
const forked = await session.fork(options);
// forked has the parent's full timeline, tools, and state
// diverges from this point forward
```

- **Inherited**: timeline, tools (all sources), knobs, state, middleware
- **Not inherited**: execution-scoped state, in-flight tool calls
- **Independent after fork**: new messages, tool calls, state changes don't propagate back
- **Use cases**: speculative execution (try multiple approaches), checkpointing (save-and-explore), A/B testing (same context, different models)

`spawn()` is delegation ("go do this task for me"). `fork()` is branching ("continue from here in a different direction").

---

### Near-term: applyEdits overhaul

The `applyEdits` utility in `@agentick/sandbox` needs a richer API for surgical code editing. Current API is find-and-replace only. Target: a jQuery-like fluent API for file navigation and editing.

**Operations to add:**

- **Line-addressed edits** — `{ line: 42, insert: "before" | "after", content: "..." }` for when you know the line number
- **Insert before/after** — `{ after: "pattern", content: "new line" }` without replacing the matched text
- **Regex matching** — `{ old: /pattern/g, new: "replacement" }` with capture group support
- **Range operations** — `{ from: "start pattern", to: "end pattern", replace: "..." }` for multi-line block replacement
- **Delete** — `{ delete: "pattern" }` or `{ deleteLine: 42 }` for removal without replacement

**Inspiration:**

- **jQuery**: selectors locate, chainable operations transform — `.find().after().remove()`
- **Unix tools**: `sed` (stream transforms), `awk` (pattern-action), `patch` (hunks with context)
- **Modern codemods**: jscodeshift (AST-based), comby (structural matching), tree-sitter (syntax-aware)

The key insight: models are bad at counting lines but good at pattern matching. The API should make pattern-based edits the primary mode, with line numbers as an optional hint for disambiguation.

---

### Near-term: Gateway Input Validation

The gateway is a system boundary — untrusted data arrives over WebSocket/Unix socket RPC. Today, method handlers trust whatever the client sends. Malformed payloads (wrong shape, missing fields, garbage content blocks) pass through unchallenged and blow up deep in the stack with inscrutable errors.

- **`SendParams` validation** — verify `input.messages` exists and is an array when `input` is provided, reject requests with neither `input` nor `message`
- **General method param validation** — validate against `method-schemas.ts` JSON schemas at the gateway boundary, before dispatching to handlers
- **Structured error responses** — return `VALIDATION_TYPE` / `VALIDATION_REQUIRED` errors with actionable messages, not stack traces from the kernel

This is not a major phase — it's boundary hygiene. The JSON schemas already exist in `method-schemas.ts`; the gap is that nothing actually validates incoming params against them.

---

### Phase 2: Session Persistence

Sessions are ephemeral today — they die when the process dies. Persistence makes them durable.

- **`SessionStore` interface** — pluggable storage backends (file, SQLite, Postgres, Redis)
- **JSONL history format** — append-only, human-readable, debuggable
- **Auto-persist/restore** — sessions auto-save after execution, auto-restore on access ✅
- **Reset policies** — daily, idle-based, manual (archive old session, create fresh one)

Design in `plans/agentic/sessions.md`.

**What this unlocks for the framework:** Any application that needs conversation continuity across restarts. Chatbots, long-running assistants, workflow systems with durable state. Also enables the virtual actor pattern — sessions are logically persistent, physically ephemeral, routable to any instance.

---

### Phase 3: Context Management

Applications hit context limits. The framework should handle this, not every app independently.

- **Context pruning strategies** — tool-result trimming, sliding window, summarization
- **Token budget enforcement** — already partially implemented via `<Timeline>` props
- **Eviction hooks** — `onEvict` callback for apps that need to react to pruning

Parts of this exist (`AgentTokenBudgetConfig` in the Agent component). The gap is making pruning strategies first-class and composable at the framework level.

**What this unlocks for the framework:** Any long-running application. Without this, every app reinvents context window management.

---

### Phase 4: Messaging Pipeline

Messages arrive from multiple sources — chat UIs, API calls, webhooks, other sessions, scheduled triggers. The framework needs a standard way to route, deduplicate, and queue them.

- **Queue modes** — `interrupt`, `steer`, `followup`, `collect`
- **Middleware** — `<Dedupe>`, `<Debounce>`, `<RateLimit>` as composable components
- **Routing** — `<MessageRouter>` with channel-aware, pattern-based routing
- **Message type** — standardized envelope with `channel`, `sender`, `metadata`

Design in `plans/agentic/messaging.md`.

**What this unlocks for the framework:** Multi-channel applications. Any app receiving input from more than one source needs this — not just agents, but also webhook-driven pipelines, event processors, multi-user chat systems.

---

### Phase 5: Execution Environments

The framework compiles a component tree into structured context (tools, sections, state, timeline). Today, the only consumer is the model adapter — everything compiles "for the model." But the model isn't the only possible consumer.

An **execution environment** controls how compiled context is consumed and how tool calls execute. It's a cohesive unit — matched model input preparation + tool execution wrapping + lifecycle hooks.

```typescript
const app = createApp(MyAgent, {
  environment: replEnvironment({ extensionsDir: "~/.agentick/extensions" }),
});
```

- **`appOptions.environment`** — pluggable execution environment with model executor, tool executor, and lifecycle hooks
- **Tool metadata** — tools carry environment-specific metadata (framework passes through, doesn't interpret)
- **Default environment** — today's behavior (model calls tools via tool_use protocol)
- **Lifecycle hooks** — `onSessionCreate`, `onSessionRestore`, `onSessionPersist` for environment-managed state

Design explored in CONTEXT.md ("Execution Environments: The REPL Model").

**What this unlocks for the framework:** Sessions become general-purpose execution contexts, not just LLM chat loops. REPL-driven coding agents, data pipelines, hybrid human-AI workflows — all compositions of the same primitives with different environments.

#### Extension System (via Packages)

Packages remain the primary extension mechanism (`plans/agentic/plugins.md`). Three tiers:

1. **Packages** — export tools, hooks, components. No registration needed. ✅
2. **Provider pattern** — managed collections with context + hooks + tools. ✅
3. **`definePlugin()`** — framework-level integration for middleware, lifecycle hooks, DevTools panels.

The execution environment abstraction subsumes much of what tier 3 was designed for. `definePlugin()` still matters for cross-cutting concerns (analytics, rate limiting, DevTools), but environment-specific behavior belongs in the environment.

---

## Ecosystem Packages

These are **not part of the core framework**. They're separate packages that any agentick application can opt into. They live in the monorepo for development convenience but ship as independent npm packages.

### System Tools — `@agentick/tools-system`

File read/write, directory listing, shell execution, HTTP fetch. Built with `createTool()`. Any application that needs system access uses these — agents, automation pipelines, dev tools.

### Memory — `@agentick/memory`

Long-term recall across sessions. File-based storage (markdown), hybrid search (BM25 + optional vector). Explicit storage (model calls `memory_store`). Designed in `plans/agentic/memory.md`.

Depends on session persistence (Phase 2) for cross-session context. Vector providers are pluggable sub-packages (`@agentick/memory-openai`, `@agentick/memory-local`).

### REPL Environment — `@agentick/repl`

A complete execution environment that transforms how sessions execute. Instead of the model calling tools via tool_use protocol, the model writes code that runs in a sandboxed REPL where tools are callable functions.

- **REPL execution environment** — model executor renders tools as command descriptions in context (not tool schemas), exposes a single `execute` tool. Tool executor runs code in sandbox with all tools as callable functions.
- **Filesystem-backed sandbox** — per-session working directory, extensions dir, state. Layered extension resolution: session → project → user → built-in.
- **System tools** — `read`, `write`, `update`, `bash` — the filesystem primitives. Everything else is a command in the REPL.
- **Self-extension** — agent creates commands at runtime (`define_command`), saves to disk (`save_command`), auto-loaded on restore. The `.vimrc` pattern for agents.
- **The `execute` tool spawns** — each `execute` call spawns a lightweight child session with focused context (task + commands, no full conversation history). Rapid iteration without context weight.
- **Parent context access** — spawned children can search the parent's timeline/state on demand without paying for it every tick.

Depends on spawn() (Phase 1) for the execute-as-spawn pattern. Depends on execution environments (Phase 5) for the environment abstraction.

This is the capability multiplier. Instead of pre-building every integration, the agent composes operations in code. Instead of a plugin system, the agent extends itself by writing functions.

### Connectors — `@agentick/connector-*`

Bidirectional platform adapters built on channels. Slack, Discord, Telegram, WhatsApp, email. Each is a separate package. Hierarchical config: gateway (infra) → app (availability) → session (binding).

Built on demand. The community extends.

### CLI — `@agentick/cli`

Terminal client for interacting with agents. Streaming output, markdown rendering, debug mode. Works with both embedded SSE servers and gateway WebSocket. Design in `plans/agentic/cli.md`.

---

## Not Prioritized

| Feature                  | Why it waits                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Federation**           | Cross-gateway session routing. Matters at scale, not for early adopters. ~50 lines of core code when needed. |
| **Agent-as-Markdown**    | `loadAgent("worker.md")` — nice DX, but config objects and JSX work today.                                   |
| **Guardrail expansions** | `inputGuardrail`, `outputGuardrail` — production hardening, not foundational.                                |

---

## Validation

The roadmap is a hypothesis. It gets validated by building real applications on the framework:

- **Personal assistant** — exercises spawn, memory, REPL, system tools, connectors, session persistence. The most demanding consumer. Separate project.
- **Example apps** — lightweight showcases in `example/`. Demonstrate framework patterns without being production software.
- **Community feedback** — what people actually try to build reveals what's actually missing.

Framework priorities shift based on what applications need. If session persistence blocks three different apps, it moves up. If messaging pipeline has no consumers yet, it waits.

---

## Principles

1. **Framework provides primitives, not products.** spawn(), sessions, routing, plugins — not "personal assistant features."
2. **Ecosystem builds on the framework.** Memory, system tools, REPL, connectors are packages, not core. Applications choose what they need.
3. **Real usage drives priority.** Build applications. Hit walls. Fix the framework. Repeat.
4. **One way to do things, done well.** No feature flags, no backwards compat shims, no "also supports X."
5. **Files over magic.** History is JSONL. Memory is markdown. Configuration is code. Everything is inspectable and debuggable.
