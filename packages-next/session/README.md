# @agentick/session-next

**SessionHarness — one agent run, one long-lived conversation.**

The integration site where v2's harness surfaces — reconciler, loop
executor, tool executor, timeline, knobs, state, elicitation, tasks,
prompts — wire together for a single conversation. One session per
human dialog; sessions are created by an app harness and persist
across ticks.

Private workspace package. Bundled into the `agentick` metapackage;
not published independently.

## Quick start

Most adopters never construct a `SessionHarness` directly — they
write an agent (a function or React component returning JSX
declarations) and call `createApp(MyAgent, options).run(input)`. The
app harness spins up a session per run.

For session-level commands (REPL apps, agent-side asks not initiated
by tool dispatch, snapshot/restore workflows), reach for the
session surface directly:

```ts
const session = await app.createSession({ messages: [...] });

// Reactive primitives — every session has these (per ADR 27).
session.timeline      // TimelineHandle — durable conversation history
session.knobs         // KnobsHandle — model-facing reactive config
session.state         // StateHandle — persisted session state
session.tasks         // TasksHarnessProtocol — long-running work registry

// Elicitation — ask the user for typed input.
session.elicitation   // ElicitationHarnessProtocol — raw substrate
session.elicit        // Elicit — sugar surface (preferred)

// Dispatch + send.
await session.dispatch("rename-file", { from: "a", to: "b" });
await session.send({ messages: [{ role: "user", content: [...] }] });
```

## `session.elicit` vs. `session.elicitation`

Per ADR 43 §"Sugar surfaces converge": every session exposes two
surfaces for asking the user:

| Surface               | Type                               | Use when                                                                                                                             |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `session.elicit`      | `Elicit` (sugar)                   | typed single-call asks — `text`, `confirm`, `select`, `number`, `boolean`, `url`, `multiSelect`, `requireUrls`, plus `try*` variants |
| `session.elicitation` | `ElicitationHarnessProtocol` (raw) | structured request with `Standard-Schema` validator + bespoke timeout/abort/hints control                                            |

The sugar `Elicit` interface is identical to what tool handlers see
via `ctx.elicit` (whether dispatched in-process or via MCP server).
Adopter code using `await session.elicit.text(...)` is the canonical
shape; reach for the raw protocol only when the sugar is too narrow.

```ts
// 90% case — sugar
const name = await session.elicit.text("Your name?");
const role = await session.elicit.select("Role?", ["admin", "user"] as const);

// Decline / cancel throw typed errors
try {
  await session.elicit.confirm("Apply changes?");
} catch (err) {
  if (err instanceof ElicitationDeclined) {
    /* user declined */
  }
  if (err instanceof ElicitationCancelled) {
    /* user cancelled */
  }
}

// Non-throwing variants
const outcome = await session.elicit.tryConfirm("Apply?");
if (outcome.status === "accept" && outcome.value) {
  /* proceed */
}
```

See [`@agentick/elicitation-next`](../elicitation/README.md) for the
full `Elicit` interface contract.

## Surface integration

```
SessionHarness
├── reconciler (per-tick, ephemeral)       — JSX → RenderedTree
├── loopExecutor (per-tick, ephemeral)     — runs ticks until terminal
├── toolExecutor (session-scoped)          — dispatch handlers; ctx.elicit, ctx.tasks
├── timeline (session-scoped, durable)     — message + section + event log
├── knobs (session-scoped, reactive)       — model-visible config
├── state (session-scoped, persisted)      — internal session state
├── elicitation (session-scoped)           — raw substrate primitive
│   └── elicit                             — sugar surface (Elicit interface)
├── tasks (session-scoped)                 — long-running work registry
└── prompts (session-scoped, optional)     — when withPrompts mounted
```

Every harness whose lifecycle is bound to a session is constructed
once per session at create-time and surfaced both:

1. On the `SessionHarnessProtocol` (this object) for adopter code, AND
2. Via `bridges.<name>` inside reconciler / executor flow.

The two views point at the SAME instance. `session.elicitation ===
bridges.elicitation` always.

## `defineSession` — adopter-facing factory

Most adopters use `createApp(MyAgent, options)` which constructs
sessions via `defineSession` under the hood. For custom session
shapes (testing, alternative runtime topologies), call directly:

```ts
import { defineSession } from "@agentick/session-next";

const factory = defineSession({
  // every callback is optional — defaults provided
  onSend: async ({ messages }) => {
    /* ... */
  },
  onDispatch: async (name, input) => {
    /* ... */
  },
  // harness surfaces — provide explicitly or accept defaults
  timeline: customTimelineHandle,
  knobs: customKnobsHandle,
  state: customStateHandle,
  elicitation: existingElicitationHarness, // optional; factory builds one if absent
  tasks: existingTasksHarness, // optional; same
});

const session = factory({ scopeId: "test-session" });
```

The factory eagerly constructs all session-scoped harnesses (so the
SessionHarnessProtocol slots are immediately populated) and wires the
substrate primitives through to `bridges.*` for in-tree code.

## Status

- ✅ SessionHarness construction + lifecycle
- ✅ Per-session timeline / knobs / state / elicitation / tasks
- ✅ ToolBridge integration with layered tool registry (#135-#141)
- ✅ `session.elicit` sugar surface (#272 / ADR 43)
- ✅ Session execution handle (`send` → `ProcedurePromise<SessionExecutionHandle>`)
- ✅ Session snapshot / restore protocol
- ⏳ `session.prompts` — depends on whether withPrompts is mounted (ADR 42 audit)

## Verified by

- `src/__tests__/harness.spec.ts` — construction, lifecycle, bridge
  surface, snapshot/restore.
- `src/__tests__/dispatch.spec.ts` — session.dispatch routing through
  ToolExecutor.
- `src/__tests__/define-session.spec.ts` — defineSession factory wiring.
- See also the workspace-wide session integration tests in
  `@agentick/app-next/__tests__/`.

## See also

- [ADR 43 — Unified ToolHandlerCtx](../../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md)
  — the cross-transport sugar story `session.elicit` participates in.
- [`@agentick/elicitation-next`](../elicitation/README.md) — the
  underlying ElicitationHarness + `Elicit` sugar contract.
- [`@agentick/app-next`](../app/README.md) — the parent harness that
  spins sessions up per run.
- [ADR 26 — Harness API shape](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
