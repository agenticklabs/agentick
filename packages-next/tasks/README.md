# @agentick/tasks-next

**TasksHarness** — substrate-level long-running tool primitive.

Every managed execution that takes longer than "one tick" — a slow shell
command, a deploy step, an MCP server's `task: {ttl}` invocation, a
multi-minute model completion — funnels through this one protocol so
the lifecycle FSM, progress envelope, correlation engine, and
cancellation semantics live in exactly one place.

Same FSM as MCP's task model (`working / input_required / completed /
failed / cancelled`); cluster-friendly via inbox-routed cancel / get /
result and bus-channel status + progress notifications. Per ADR-23
§OQ23.15 ("substrate-aware Tasks bridge"), local invocations and
MCP-wire invocations of a `taskSupport: required` tool both return the
same `TaskHandle` shape — the MCP wire codec layers on top via a
separate phase.

Private workspace package. Bundled into the `agentick` metapackage;
not published independently.

## Status

🚧 In active development as part of v2 (`feat/v2`).

| Phase | What                                                                                                                                              | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A     | Substrate primitive — harness, registry, progress, cancel, conformance                                                                            | ✅     |
| A.1   | ToolExecutor integration — `ctx.tasks` on every handler, TaskHandle-return detection, Pattern A vs B branching on `taskSupport` annotation (#156) | ✅     |
| A.2   | Model-facing `session_tasks_*` tools — auto-registered `session_tasks_list / get / cancel / await` so the model can manage Pattern B tasks (#157) | ✅     |
| B     | MCP wire codec — `tools/call` task opt-in, `notifications/tasks/status` translation, inbound `tasks/cancel`                                       | ⏳     |
| D     | Effect-native internals refactor — `Stream<TaskEvent>` for events, `Effect<TaskHandle>` work overload with real fiber interruptibility (#155)     | ⏳     |

## Quick start

### Install on a session

```ts
import { createApp } from "@agentick/app-next";
import { withTasks } from "@agentick/tasks-next";

const app = await createApp(<Agent />, {
  executor,
  extensions: [withTasks()],
});

const session = await app.createSession();
```

`withTasks()` constructs a per-session `TasksHarness` at install time
and registers it under the `tasks` slot — reachable as `session.tasks`,
`bridges.tasks`, and `ctx.tasks` from any tool handler on that
session.

> The `agentick` metapackage bundles `withTasks()` automatically.
> The standalone `withTasks()` import is for adopters wiring `app-next`
> directly without the metapackage.

### Submit a task from a tool handler

```ts
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const Deploy = createTool({
  name: "deploy",
  description: "Deploy the current branch.",
  input: z.object({ target: z.string() }),
  annotations: { taskSupport: "required" }, // Pattern B — see below
  handler: async ({ target }, { ctx }) => {
    return ctx.tasks!.submit(
      async ({ signal, onProgress, setStatusMessage }) => {
        setStatusMessage(`provisioning ${target}`);
        for (let step = 0; step < 10; step++) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          onProgress({ current: step, total: 10, message: `step ${step}` });
          await doWorkChunk();
        }
        return [{ type: "text", text: `deployed to ${target}` }];
      },
      { statusMessage: "queued", ttl: 5 * 60_000 },
    );
  },
});
```

The handler returns the `TaskHandle` directly. What happens next
depends on the `taskSupport` annotation on the tool:

### Pattern A — model-transparent (default)

`taskSupport: "unsupported"` (or omitted) → the **executor awaits
`handle.result` transparently**. The model sees the eventual content
blocks; it never sees a task id. Use this for any tool whose only
reason to use `submit` is to get progress envelopes / signal-aware
cancellation — the long-running shape is an implementation detail.

### Pattern B — model-visible task ref

`taskSupport: "required"` → the executor **returns immediately** with a
typed task-ref content block (`{ _kind: "session_task_ref", taskId,
status, statusMessage?, ttl? }`) instead of awaiting. The model now owns
the task and manages it via the four auto-registered model-facing
tools (see [Model-facing tools](#model-facing-tools) below).

This is the MCP `taskSupport: "required"` semantic — bring the model
into the conversation about long-running work instead of blocking a
tick on it.

The `_kind: "session_task_ref"` discriminator matches the `session_*`
namespace used by the model tools — `session_tasks_get`,
`session_tasks_cancel`, etc. consume the `taskId` from this ref.

## Model-facing tools

When `withTasks()` is installed, four tools are auto-registered into
every session so the model can manage Pattern B (`taskSupport:
"required"`) tasks across ticks:

| Tool                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `session_tasks_list`   | List every framework background task in this session             |
| `session_tasks_get`    | Fetch a single task's `TaskInfo` snapshot by id                  |
| `session_tasks_cancel` | Abort an in-flight task (idempotent)                             |
| `session_tasks_await`  | Block this tick until a task reaches terminal; return its blocks |

### Naming: why `session_*`, why underscores

- **`session_`** — these tools are scoped to the current conversational
  session and managed by the framework, not by the user's domain. The
  prefix prevents collision with the broad set of user-provided "tasks"
  tools (todos, project trackers, kanban). It also doesn't leak brand
  (`agentick.*`) or jargon (`runtime.*`) — the model doesn't need to
  know it's in a framework, only that these tools manage _its_ in-flight
  work.
- **Underscores, not dots** — some providers historically rejected dots
  in tool names (OpenAI). Underscores work universally across OpenAI,
  Anthropic, Google, and MCP.

The same namespace is reserved for future model-visible framework
primitives: `session_knobs_*`, `session_timeline_*`,
`session_state_*`, etc.

### Opting out

```ts
withTasks({ registerModelTools: false });
```

Skips the model surface. Use this for headless adopters that drive
tasks from server code with no LLM in the loop — the substrate
(`ctx.tasks`, `bridges.tasks`) is still wired, but the model doesn't
see the four tools.

### Observe events directly (advanced)

The `TaskHandle` exposes an event stream and a snapshot accessor:

```ts
const handle = session.tasks.submit(async ({ onProgress }) => {
  for (let i = 0; i < 10; i++) {
    onProgress({ current: i, total: 10 });
    await doWorkChunk();
  }
  return [{ type: "text", text: "done" }];
});

for await (const event of handle.events()) {
  if (event.kind === "progress") {
    console.log(`progress: ${event.current}/${event.total}`);
  } else if (event.kind === "status" && event.info.status === "completed") {
    break;
  }
}

const result = await handle.result; // resolves with ContentBlock[]
```

## What this package owns

- **`TasksHarness`** — `BaseHarness<"tasks">` impl. Per-session
  registry; cluster-friendly via inbox + bus.
- **`withTasks()`** — `SessionExtension` factory; constructs the
  harness on session install and registers the `tasks` namespace.
- **Bus channels** —
  - `session:channel:task-status` for FSM transitions (payload:
    `TaskInfo`).
  - `session:channel:task-progress` for in-flight updates (payload:
    `{ taskId, current, total?, message? }`).
- **Inbox message types** — `tasks-cancel`, `tasks-get`,
  `tasks-result`. Cluster-portable cross-harness operations route
  through these against `harness.address`.
- **Conformance suite** — `runTasksHarnessConformance(factory)`
  exported from the package root. Any impl of
  `TasksHarnessProtocol` can be driven through the same 12-test
  battery to prove protocol compliance.
- **Test doubles** under `/testing` — `fakeTasks()` + `stubTasks()`,
  per the Meszaros vocabulary (see "Test doubles" below).

## API

### `submit(work, opts?)`

```ts
submit<T = readonly ContentBlock[]>(
  work: (ctx: TaskWorkContext) => Promise<T> | T,
  opts?: { ttl?: number; pollInterval?: number; statusMessage?: string },
): TaskHandle<T>
```

Returns synchronously. The work fn is invoked **synchronously up to
its first await** so that `signal.addEventListener("abort", ...)`
inside the work registers BEFORE any concurrent `cancel()` /
`close()` could fire — AbortSignal listeners attached post-abort don't
fire.

`TaskWorkContext`:

- `signal: AbortSignal` — aborts on `cancel()` / harness `close()`.
- `onProgress(update: ProgressUpdate): void` — emit progress.
- `setStatusMessage(message: string): void` — update the human-readable
  status without emitting a progress event.

### `TaskHandle<T>`

- `taskId: string`
- `initialStatus: TaskStatus` — snapshot at handle construction.
- `result: Promise<T>` — resolves on `completed` with the work's
  return value; rejects with `TaskRejection` on `failed` /
  `cancelled`.
- `info(): TaskInfo` — live snapshot.
- `events(): AsyncIterable<TaskEvent>` — emits the current status
  snapshot, then live progress + status transitions, closes on
  terminal.
- `cancel(reason?: string): Promise<void>` — cluster-portable cancel.
  No-op if already terminal.

### Lookups by id

`get(id)`, `status(id)`, `result(id)`, `cancel(id, reason?)`,
`events(id)`. All throw `UnknownTaskError` (`_tag`-discriminated) for
unknown ids — same shape across local and cluster paths.

### `TaskStatus`

`"working" | "input_required" | "completed" | "failed" | "cancelled"` —
maps 1:1 to MCP's task FSM. `input_required` is declared for
forward-compat with MCP but Phase A doesn't auto-transition into it;
tools that pause on `ctx.elicitation` stay `working` until Phase B's
auto-pause integration ships.

## Test doubles

Per the test-doubles convention (Meszaros), every layer exports its
doubles under a `/testing` subpath. For tasks:

### `fakeTasks(options?)` — working impl

A real `TasksHarness` on a fresh in-memory substrate. Returns the
harness, the substrate primitives (so tests can subscribe to the bus,
assert journal entries, etc.), and an idempotent `close()`.

```ts
import { fakeTasks } from "@agentick/tasks-next/testing";

const { harness, bus, journal, inbox, close } = await fakeTasks();
try {
  const handle = harness.submit(async () => [{ type: "text", text: "ok" }]);
  expect(await handle.result).toEqual([{ type: "text", text: "ok" }]);
} finally {
  await close();
}
```

Options:

- `harnessId?: string` — defaults to `"fake-tasks"`.
- `sessionId?: string` — stamps `parentScope.sessionId` on every
  envelope, mirroring the real `withTasks()` install path.

### `stubTasks(options?)` — canned-answer stub

No substrate, no registry, no work runner. Satisfies
`TasksHarnessProtocol` with `submit` returning a pre-completed
handle and a single status event. Use when a downstream consumer
needs to _receive_ a `tasks` slot without exercising the lifecycle.

```ts
import { stubTasks } from "@agentick/tasks-next/testing";

const tasks = stubTasks({
  cannedResult: [{ type: "text", text: "pretend done" }],
  onSubmit: (work, opts) => console.log("submit observed", opts),
});
```

Options:

- `id?: string` — defaults to `"stub-tasks"`. Surfaces as `id` /
  `address` (`tasks:${id}`).
- `cannedResult?: readonly ContentBlock[]` — what `result` /
  `handle.result` resolves with. Defaults to `[]`.
- `onSubmit?: (work, opts) => void` — observe submission args without
  exercising the work fn.

Both doubles are typed against the spec interface
(`TasksHarnessProtocol`), so spec changes break stale doubles at
compile time — no silent drift.

## Conformance

`runTasksHarnessConformance(factory)` drives any
`TasksHarnessProtocol` impl through a 12-test suite covering: submit

- result, work-fn errors, cancel, progress envelope, events stream,
  unknown-id errors, harness-close cancellation of in-flight tasks.
  Lives at the package root so adopter impls (cluster-shimmed variants,
  custom registries) import it without reaching into `/testing`:

```ts
import { runTasksHarnessConformance } from "@agentick/tasks-next";

runTasksHarnessConformance(async ({ harnessId }) => {
  const bundle = await yourFactory(harnessId);
  return { harness: bundle.harness, close: bundle.close };
});
```

## What does NOT belong here

- **MCP wire encoding** — lives in `@agentick/mcp-next`, layers on top.
  This package's harness is wire-agnostic.
- **Persistence across process restart** — tasks survive the
  session's process lifetime only. Cross-restart resumption is a
  substrate concern (future cluster-store integration).
- **ToolExecutor return-shape detection** — the executor's logic for
  detecting a `TaskHandle` return and branching on `taskSupport`
  lives in `@agentick/tool-executor-next` (#156).

## Verified by

- `src/__tests__/harness.spec.ts` — 18 tests covering submit /
  result / progress envelope / cancel / close / events / errors /
  identity / subscriber fan-out / synchronous-first-tick abort
  semantics.
- `src/__tests__/cluster-inbox.spec.ts` — 4 tests covering
  cluster-portable cancel / get / result via inbox addressing.
- `src/__tests__/conformance.spec.ts` — drives
  `runTasksHarnessConformance` against `TasksHarness` (13 protocol
  tests).
- `src/__tests__/session-tasks-tools.spec.ts` — 15 tests covering
  every model-facing tool's handler directly (no tool-executor in
  the dep tree to avoid `tasks ↔ tool-executor` cycle): list / get
  / cancel / await against known + unknown ids, structured failure
  shape, bundle structural assertions, sessionId-scoped handler
  refs, extension factory smoke.
- `packages-next/tool-executor/src/__tests__/task-handle.spec.ts`
  (sibling package) — 6 tests covering `ctx.tasks` wiring, Pattern A
  (await transparently), Pattern B (return task-ref), and abort
  propagation from dispatch into the in-flight task.

## Roadmap & known gaps

- **Phase B (MCP wire codec)** — `mcp-next` translates inbound MCP
  `tools/call` with `task: {ttl}` into `submit`; outbound MCP wire
  serializes our TasksHarness state into `notifications/tasks/status`
  - `notifications/progress`. Tracked separately.
- **Phase D (Effect-native internals, #155)** — convert the
  per-subscriber `Queue<TaskEvent>` fan-out to `Stream.fromQueue`,
  expose an `Effect<TaskHandle>` work overload that runs as a real
  interruptible fiber.
- **`input_required` transitions** — declared in `TaskStatus` for
  forward-compat with MCP's FSM, but Phase A doesn't auto-transition
  into it. When a task's work fn pauses on an elicit / sampling /
  roots request, Phase B's auto-pause integration will set the status.
- **`taskSupport: "supported"`** — the caller-choice mode declared in
  the spec annotation but not yet branched on by the executor. Lands
  alongside Phase C, where the model has the tooling to opt in.

@see [`docs/proposals/v2/blueprint/23-mcp-as-harness.md`](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md) §Tasks
@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
