# @agentick/tool-executor

Reference implementation of `ToolExecutorProtocol` from `@agentick/spec`.

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

`ToolDeclaration.exposure` (from `@agentick/spec/data/declarations`)
decides which door is reachable:

| `exposure` | Reachable from |
| --- | --- |
| `["model"]` | model only |
| `["dispatch"]` | host only |
| `["model", "dispatch"]` | both doors |
| `["runtime"]` | internal use; neither door |

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
import { ToolExecutorHarness } from "@agentick/tool-executor";

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

## Conformance

Reference implementation passes
`runToolExecutorConformance` from
`@agentick/spec-conformance/tool-executor`.

## See also

- `@agentick/spec` — the protocol definition (`protocol/tool-executor.ts`).
- `@agentick/reconciler-react` — produces `ToolDeclaration[]` and
  captures `use:` deps at render time; the tool executor consumes them.
- `docs/proposals/v2/blueprint/07-tool-executor.md` — full design.
