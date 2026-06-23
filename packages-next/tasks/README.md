# @agentick/tasks-next

**TasksHarness** — substrate-level long-running tool primitive.

Every managed execution that takes longer than "one tick" — a slow shell
command, a deploy step, an MCP server's `task: {ttl}` invocation, a
multi-minute model completion — funnels through this one protocol so
the lifecycle FSM, progress envelope, correlation engine, and
cancellation semantics live in exactly one place.

Same FSM as MCP's task model (`working / input_required / completed /
failed / cancelled`); cluster-friendly via inbox-routed cancellation
and bus-channel status notifications. Per ADR 23 §OQ23.15
("substrate-aware Tasks bridge"), local invocations and MCP-wire
invocations of a `taskSupport: required` tool both return the same
`TaskHandle` shape — the MCP wire codec layers on top via a separate
phase.

Private workspace package. Bundled into the `agentick` metapackage;
not published independently.

## Status

🚧 In active development as part of v2 (`feat/v2`).

| Phase | What | Status |
| --- | --- | --- |
| A | Substrate primitive — harness, registry, progress, cancel, conformance | ✅ |
| B | MCP wire codec — `tools/call` task opt-in, `notifications/tasks/status` translation, inbound `tasks/cancel` | ⏳ |
| C | Model-visible task ids — `taskSupport: "required"` tool returns immediately to the model with a task ref instead of awaiting | ⏳ |

## Quick start

```ts
import { withTasks } from "@agentick/tasks-next";

const app = await createApp(<Agent />, {
  executor,
  extensions: [withTasks()],
});

const session = await app.createSession();

// Inside a tool handler:
const handle = session.tasks.submit(async ({ signal, onProgress }) => {
  for (let i = 0; i < 10; i++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    onProgress({ current: i, total: 10, message: `step ${i}` });
    await doWorkChunk();
  }
  return [{ type: "text", text: "deploy complete" }];
});

// Caller can observe / cancel:
for await (const event of handle.events()) {
  if (event.kind === "progress") {
    console.log(`progress: ${event.current}/${event.total}`);
  } else if (event.kind === "status" && event.info.status === "completed") {
    break;
  }
}

const result = await handle.result; // ContentBlock[] from the work fn
```

## What this package owns

- **`TasksHarness`** — `BaseHarness<"tasks">` impl. Per-session
  registry; cluster-friendly via inbox + bus.
- **`withTasks()`** — `SessionExtension` factory; constructs the
  harness on session install.
- **Bus channels** —
  - `session:channel:task-status` for FSM transitions (payload:
    `TaskInfo`).
  - `session:channel:task-progress` for in-flight updates (payload:
    `{ taskId, current, total?, message? }`).
- **Test doubles** under `/testing` — `fakeTasks()` (real harness on
  in-memory substrate) + `stubTasks()` (canned-answer stub).

## API

### `submit(work, opts?)`

```ts
submit<T>(
  work: (ctx: { signal, onProgress, setStatusMessage }) => Promise<T> | T,
  opts?: { ttl?, pollInterval?, statusMessage? },
): TaskHandle<T>
```

Returns immediately. The work fn runs synchronously up to its first
await — this guarantees `signal.addEventListener("abort", ...)`
registers BEFORE any concurrent `cancel()`/`close()` could abort the
signal (AbortSignal listeners don't fire when attached post-abort).

### `TaskHandle<T>`

- `taskId`
- `initialStatus` (snapshot at handle construction)
- `result: Promise<T>` — resolves on `completed`, rejects with
  `TaskRejection` on `failed`/`cancelled`.
- `info()` — current `TaskInfo`.
- `events()` — `AsyncIterable<TaskEvent>` — emits the current
  snapshot, then progress + status transitions, closes on terminal.
- `cancel(reason?)` — abort and transition to `cancelled`.

### Lookups by id

`get(taskId)`, `status(taskId)`, `result(taskId)`, `cancel(taskId)`,
`events(taskId)`. All throw `UnknownTaskError` (`_tag` discriminated)
for unknown ids.

## What does NOT belong here

- **MCP wire encoding** — lives in `@agentick/mcp-next`, layers on top.
  This package's harness is wire-agnostic.
- **Persistence** — tasks survive the session's process lifetime
  only. Cross-restart resumption is a substrate concern (future
  cluster-store integration).
- **Tool-handler-return integration** — the ToolExecutor's logic for
  detecting a `TaskHandle` return and awaiting it transparently lives
  in `@agentick/tool-executor-next` (separate slice).

## Verified by

- `src/__tests__/harness.spec.ts` — 18 tests covering submit / result
  / progress envelope / cancel / close / events / errors / identity.

## Roadmap & known gaps

- **Phase B (MCP wire codec)** — `mcp-next` translates inbound MCP
  `tools/call` with `task: {ttl}` into `submit`; outbound MCP wire
  serializes our TasksHarness state. Tracked separately.
- **Phase C (model-visible task ids)** — currently the ToolExecutor
  awaits the handle's `result` transparently (the model sees the
  eventual result, not the task id). MCP's `taskSupport: required`
  needs the model to see the task ref so it can cancel / poll
  explicitly. Needs JSX surface + tool annotation wiring.
- **`input_required` transitions** — declared in `TaskStatus` for
  forward-compat with MCP's FSM, but Phase A doesn't auto-transition
  into it. When a task's work fn pauses on an elicit/sampling/roots
  request, Phase B's auto-pause integration will set the status.
- **Conformance suite** — Phase A ships the impl-specific spec only.
  A cross-impl `runTasksHarnessConformance(factory)` suite (mirroring
  the elicitation pattern) lands when a second impl needs to honor
  the protocol.

@see [`docs/proposals/v2/blueprint/23-mcp-as-harness.md`](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md) §Tasks
@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
