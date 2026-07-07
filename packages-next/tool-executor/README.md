# @agentick/tool-executor-next

Reference implementation of `ToolExecutorProtocol` from `@agentick/spec-next`.

The tool executor is the boundary that turns tool calls into tool
results. It hosts the runtime's tool registry, validates inputs against
declared schemas, runs the confirmation flow when required, invokes
handlers, and emits the full lifecycle event sequence on
`surface: "tool"`.

## Two doors

One harness; two callers.

- **Model door** — the loop executor invokes `dispatch({ via: "model" })`
  when the model emits a `tool_use` block.
- **Host door** — the session harness invokes
  `dispatch({ via: "dispatch" })` when application code calls
  `session.dispatch(name, input)`.

Same validation, same confirmation flow, same interceptors. `via` is
observable to middleware so policies can branch on door without
inspecting private fields.

## Exposure routing

`ToolDeclaration.exposure` (from `@agentick/spec-next/data/declarations`)
decides which door is reachable:

| `exposure`              | Reachable from             |
| ----------------------- | -------------------------- |
| `["model"]`             | model only                 |
| `["dispatch"]`          | host only                  |
| `["model", "dispatch"]` | both doors                 |
| `["runtime"]`           | internal use; neither door |

The harness enforces exposure at dispatch time
(`ToolPermissionError` for the wrong door).

## Status

Phase 4a scaffold landed 2026-05-15. Substantive implementation lands
incrementally in 4a.4 (harness + dispatch happy path), 4a.5
(confirmation flow), 4a.6 (middleware + lifecycle handlers), and 4a.7
(inbox dispatcher). See
[`docs/proposals/v2/STATUS.md`](../../docs/proposals/v2/STATUS.md).

## API surface (planned)

```ts
import { ToolExecutorHarness } from "@agentick/tool-executor-next";

const exec = new ToolExecutorHarness(scopeId, journal, bus, inbox, {
  // resolve handlerRef → ToolHandler via this map (or a provider)
  handlers: handlerRegistry,
});

await exec.register({ registration: { declaration, handlerRef } });

const result = await exec.dispatch({
  toolCallId: "c_1",
  name: "calc.add",
  input: { a: 1, b: 2 },
  context: { via: "dispatch", sessionId: "s_1" },
});
// → { toolCallId, name, succeeded: true, content: [{ type: "text", text: "3" }] }
```

## Tool handler ctx surface

Tool handlers receive a unified `ToolHandlerCtx` (per ADR 43) — the
same shape whether invoked in-process by this executor OR by an
MCP-server projection. Adopter code is portable across transports.

```ts
const handler: ToolHandler = async (input, { ctx, use }) => {
  // Universal fields — every transport populates these
  ctx.toolCallId;     // string
  ctx.signal;         // AbortSignal
  ctx.transport;      // "in-process" (here) or "mcp" (MCP-server projection)
  ctx.task;           // "auto" | "ref" | "inline"

  // Sugar surfaces — cross-transport portable
  await ctx.elicit?.text("Your name?");      // Elicit sugar (same as session.elicit + MCP ctx.elicit)
  const task = ctx.tasks?.submit(...);       // Tasks raw protocol

  // Raw protocol access (power users)
  await ctx.elicitation?.elicit({mode, message, schema}); // raw ElicitationHarness

  // Runtime signals — out-of-band diagnostics + liveness (ADR 64)
  ctx.log("info", { step: "started" }, "my-tool"); // → tool:signal:log bus event
  ctx.progress("job-1", { progress: 3, total: 10, message: "…" }); // → tool:signal:progress

  // MCP-specific extras — undefined unless transport === "mcp"
  ctx.mcp?.connectionId;
  ctx.mcp?.clientCapabilities;

  return [{ type: "text", text: "ok" }];
};
```

In-process ctx is built once per dispatch in the executor. The
`ctx.elicit` sugar is constructed via `buildSessionElicit({ harness:
this.elicitation })` (see `@agentick/elicitation-next`); identical
factory + interface to the session-level `session.elicit`.

### `ctx.log` / `ctx.progress` — the runtime signal family (ADR 64)

`log` and `progress` are **universal, always-present** slots (like
`emit` / `setState`) — not optional. Each call emits exactly ONE
discrete bus event (`tool:signal:log` / `tool:signal:progress`, phase
`terminal`, scoped to the dispatch's `{ sessionId, executionId,
tickId }`) via `BaseHarness.emitLog` / `emitProgress`. The emit is
**fire-and-forget** (launched with `Effect.runFork`) — never awaited,
never throws into the handler, never a control path.

Signals are **not sent to any wire directly**. Projections subscribe
to the bus and forward: the MCP-server projection →
`notifications/message` + `notifications/progress`; the agentick client
→ `subscribe` / `onLog` (see `@agentick/client-next`). Emit once
(framework), receive everywhere. Signals are structurally **bus-only**
— never journaled — so diagnostic spam can't bloat the recovery spine.

Verified by `src/__tests__/signals.spec.ts`.

## Conformance

Reference implementation passes
`runToolExecutorConformance` from
`@agentick/spec-conformance-next/tool-executor`.

## See also

- `@agentick/spec-next` — the protocol definition (`protocol/tool-executor.ts`).
- `@agentick/reconciler-react-next` — produces `ToolDeclaration[]` and
  captures `use:` deps at render time; the tool executor consumes them.
- `docs/proposals/v2/blueprint/07-tool-executor.md` — full design.
