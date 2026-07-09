# @agentick/tasks-next

**TasksHarness** — substrate-level long-running tool primitive.

Every managed execution that takes longer than "one tick" — a slow shell
command, a deploy step, an MCP server's `task: {ttl}` invocation, a
multi-minute model completion — funnels through this one protocol so
the lifecycle FSM, progress envelope, correlation engine, and
cancellation semantics live in exactly one place.

Same FSM as MCP's task model (`working / input_required / completed /
failed / cancelled`) plus `interrupted` (ADR 68 orphan accounting);
cluster-friendly via inbox-routed cancel / get / result and bus-channel
status + progress notifications. Per ADR-23 §OQ23.15 ("substrate-aware
Tasks bridge"), local invocations and MCP-wire invocations of a
`taskSupport: required` tool both return the same `TaskHandle` shape —
the MCP wire codec layers on top via a separate phase.

## Record-as-source-of-truth (ADR 68)

A task is **not** primarily an in-process fiber with the record as a
view. It is inverted: a task is a persisted **`TaskRecord`** state
machine living in a **`TaskStore`**; **how it runs** is a swappable
**`TaskExecutor`** strategy behind the record. The harness orchestrates
— `submit` writes a `working` record and starts an executor; the
executor **reports transitions** back through one uniform `report`
callback; the harness turns each transition into a `store.put` PLUS the
existing `task-status` / `task-progress` bus emit.

**The bus stays the LIVE plane; the store is the DURABLE plane** — the
wire payloads are byte-identical to the pre-ADR-68 harness, and the
bundled in-process executor is behavior-identical for the caller. The
seam is what unlocks the later tiers without a rewrite:

| Piece          | Bundled default (here)           | Conforms to the same port later                  |
| -------------- | -------------------------------- | ------------------------------------------------ |
| `TaskStore`    | `InMemoryTaskStore` (node-local) | `@agentick/tasks-postgres-next` (across-restart) |
| `TaskExecutor` | `InProcessTaskExecutor` (fiber)  | child-process (isolation) / sandbox / worker     |

- The store/executor **port types** live in `@agentick/spec-next`
  (`TaskRecord`, `TaskStore`, `TaskExecutor`, `TaskTransition`,
  `TaskStoreQuery`); the bundled impls + `runTaskStoreConformance` live
  here (mirroring `TimelineStore`).
- `get` / `list` / `status` read a synchronous **projection** the
  harness keeps in lockstep with its store writes (CQRS materialized
  view — the protocol reads are sync, the store port is async).
- **The store is app/gateway-scoped**: the AppHarness constructs one and
  injects it into every session's harness, so a `detached` task survives
  its spawning session's `close()`. See [Lifetime](#lifetime-semantics-adr-68).

Private workspace package. Bundled into the `agentick` metapackage;
not published independently.

## Status

🚧 In active development as part of v2 (`feat/v2`).

| Phase | What                                                                                                                                                               | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| A     | Substrate primitive — harness, registry, progress, cancel, conformance                                                                                             | ✅     |
| A.1   | ToolExecutor integration — `ctx.tasks` on every handler, TaskHandle-return detection, Pattern A vs B branching on `taskSupport` annotation (#156)                  | ✅     |
| A.2   | Model-facing `session_tasks_*` tools — auto-registered `session_tasks_list / get / cancel / await` so the model can manage Pattern B tasks (#157)                  | ✅     |
| B     | MCP wire codec — `tools/call` task opt-in, `notifications/tasks/status` translation, inbound `tasks/cancel`                                                        | ✅     |
| 68-A  | Record-as-source-of-truth — `TaskStore` port + `InMemoryTaskStore`, `TaskExecutor` seam + `InProcessTaskExecutor`, `detached` lifetime, `interrupted` on hydration | ✅     |
| 68-B  | Child-process executor over IPC (isolation / detached) + executor registry keyed by `.kind`, per-submit selection — conforms to the `TaskExecutor` seam            | ✅     |
| 68-pg | `@agentick/tasks-postgres-next` durable store — durable records + `interrupted`-on-restart + terminal adoption across app-process restart (cross-restart child reattach-by-pid still deferred) | ✅     |
| D     | Effect-native internals refactor — `Stream<TaskEvent>` for events, `Effect<TaskHandle>` work overload with real fiber interruptibility (#155)                      | ⏳     |

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

`withTasks()` does NOT construct the per-session `TasksHarness` —
the AppHarness owns construction via the single-construction-site
pattern (#159). The harness is reachable as `session.tasks`,
`bridges.tasks`, and `ctx.tasks` from any tool handler on that
session. What `withTasks()` does is auto-register the four
model-facing `session_tasks_*` tools so the model can list / get /
cancel / await framework tasks.

> The `agentick` metapackage bundles `withTasks()` automatically.
> The standalone `withTasks()` import is for adopters wiring `app-next`
> directly without the metapackage.

### About the trichotomy (ADR 42)

`withTasks` does NOT accept the array/instance/config-object slot trichotomy that `withSkills` / `withPrompts` / `withMCP` accept. The per-session `TasksHarness` is owned by the parent `AppHarness` (single-construction-site #159), not by this extension — constructing one here would collide on the inbox address (`tasks:${sessionId}:tasks`) and cause `bridges.tasks` / `ctx.tasks` / `session.tasks` to resolve to different instances. The only slot `withTasks` carries today is `registerModelTools` (boolean opt-out). The adopter-facing `Tasks` (= `TasksHarnessProtocol`) noun alias is still exported from `@agentick/spec-next` for downstream code that takes a `Tasks` reference directly (cross-harness wiring, custom bridges).

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

`taskSupport: "required"` → on the **model-tick path** the executor
**returns immediately** with a typed task-ref content block
(`{ _kind: "session_task_ref", taskId, status, statusMessage?, ttl? }`)
instead of awaiting. The model now owns the task and manages it via
the four auto-registered model-facing tools (see
[Model-facing tools](#model-facing-tools) below).

This is the MCP `taskSupport: "required"` semantic — bring the model
into the conversation about long-running work instead of blocking a
tick on it.

**Host-side `session.dispatch` defaults to Pattern A** even for
`taskSupport: "required"` tools (#164) — the host caller usually just
wants the final blocks. Pass `{ task: "ref" }` to opt in to Pattern B:

```ts
// host-side — awaits transparently, returns final blocks
const blocks = await session.dispatch("deploy_branch", input);

// host-side — opt in to Pattern B, returns the task-ref block
const refBlocks = await session.dispatch("deploy_branch", input, {
  task: "ref",
});
```

The `_kind: "session_task_ref"` discriminator matches the `session_*`
namespace used by the model tools — `session_tasks_get`,
`session_tasks_cancel`, etc. consume the `taskId` from this ref.

## Model-facing tools

When `withTasks()` is installed, four tools are auto-registered into
every session so the model can manage Pattern B (`taskSupport:
"required"`) tasks across ticks:

| Tool                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `session_tasks_list`   | List local + remote (MCP) framework background tasks (#175)      |
| `session_tasks_get`    | Fetch a single task's `TaskInfo` snapshot by id                  |
| `session_tasks_cancel` | Abort an in-flight task (idempotent)                             |
| `session_tasks_await`  | Block this tick until a task reaches terminal; return its blocks |

### Remote-task visibility (`session_tasks_list` → `remote` slot)

Per #175 the list handler reads `bridges.mcp` at call time and merges
each connected server's `tasks/list` snapshot into the response. The
model sees:

```json
{
  "tasks": [
    /* local TaskInfo[] */
  ],
  "remote": [
    {
      "serverId": "demo",
      "tasks": [{ "taskId": "...", "status": "working", "statusMessage": "scanning" }]
    },
    { "serverId": "broken", "error": "connection refused" },
    { "serverId": "ancient", "error": "tasks-unsupported" }
  ]
}
```

- `remote` is omitted entirely when no MCP servers are connected
  (backward-compatible with the pre-#175 response shape).
- A single down / tasks-unsupported server contributes an `error`
  entry; the rest of the listing returns normally.
- The lookup is structural — anything matching `{ clients: [{
serverId, harness: { listTasks(): Promise<{tasks}> }}] }` on the
  `mcp` slot is queried. The framework doesn't depend on
  `@agentick/mcp-next`; adopters wiring custom MCP-style integrations
  can publish the same shape and get remote-task enumeration free.

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
- **`withTasks()`** — `SessionExtension` factory; auto-registers the
  four model-facing `session_tasks_*` tools (list / get / cancel /
  await) so Pattern B is usable. Does NOT construct the harness —
  the AppHarness is the single construction site for the per-session
  `TasksHarness` (#159); this extension reads `installer.tasks` and
  `ctx.tasks` instead.
- **Bus channels** —
  - `session:channel:task-status` for FSM transitions (payload:
    `TaskInfo`).
  - `session:channel:task-progress` for in-flight updates (payload:
    `{ taskId, current, total?, message? }`).
- **Inbox message types** — `tasks-cancel`, `tasks-get`,
  `tasks-result`. Cluster-portable cross-harness operations route
  through these against `harness.address`.
- **`InMemoryTaskStore`** — the bundled default `TaskStore` (ADR 68);
  `Map`-backed, node-local, `:memory:` semantics.
- **`InProcessTaskExecutor`** — the bundled default `TaskExecutor`; the
  current Promise/Effect fiber model on the report seam.
- **Conformance suites** —
  - `runTasksHarnessConformance(factory)` — the protocol battery, any
    `TasksHarnessProtocol` impl.
  - `runTaskStoreConformance({ label, factory })` — the store-port
    battery, any `TaskStore` impl (mirrors `runTimelineStoreConformance`).
- **Test doubles** under `/testing` — `fakeTasks()` + `stubTasks()`,
  per the Meszaros vocabulary (see "Test doubles" below).

## API

### `submit(work, opts?)`

```ts
submit<T = readonly ContentBlock[]>(
  work: (ctx: TaskWorkContext) => Promise<T> | T,
  opts?: {
    ttl?: number;
    pollInterval?: number;
    statusMessage?: string;
    detached?: boolean; // ADR 68 — survive spawning session close
    input?: unknown; // audit / replay; payload a by-ref executor resolves work with
    handlerRef?: string; // by-ref work for an out-of-process executor
  },
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
- `awaitingInput<T>(promise, opts?): Promise<T>` — run `promise` in the
  `input_required` state. See below.
- `elicit: Elicit` — request input from the connected client, from inside
  a task, via request escalation (ADR 69). See below.

#### `awaitingInput` — pause on external input (`input_required`)

Wrap ANY external-input await so observers can tell **"blocked on input,
provide it"** from **"actively working"**. The task flips
`working → input_required` for the duration of the pause (optionally with a
`message` statusMessage), then back to `working` when the promise settles:

```ts
ctx.tasks.submit(async (task) => {
  // `askOperator()` returns a Promise that settles when the human answers
  // (an elicit, a webhook, a UI approval — anything external). While it's
  // pending the task shows `input_required` on the bus, the model's
  // `session_tasks_*` view, and the MCP wire.
  const answer = await task.awaitingInput(askOperator("Approve deploy to prod?"), {
    message: "awaiting approval",
  });
  if (!answer.approved) return [{ type: "text", text: "cancelled by operator" }];
  return deploy();
});
```

It is **generic — not elicitation-coupled**: wrap an elicit, MCP sampling,
a roots request, a webhook, any external await. Tasks take no dependency on
elicitation. The flip runs through the same `report` seam as `onProgress` /
`setStatusMessage`, so it lands on the durable `TaskStore` record, the
`task-status` bus channel, AND the MCP wire (which maps `input_required`
1:1). A `finally` restores `working` even if the promise **rejects** — so a
throw can't strand the task paused. And if the task is **cancelled while
paused**, the caller's `cancelled` transition wins (it's terminal); the
`finally`'s `working` report is a post-terminal no-op, so cancel is honored
— the task does not revert. `input_required` means "provide input," a state
distinct from `working`.

#### `ctx.elicit` — ask the client, from inside a task (ADR 69)

`awaitingInput` is generic but leaves you holding the promise. When the
"external input" you want is a structured answer **from the connected
client**, use `ctx.elicit` — the same [`Elicit`](../elicitation) sugar a
tool handler sees (`text`, `confirm`, `select`, `number`, `form`, the
`try*` variants), but sourced through **request escalation** instead of a
live per-tick elicitation:

```ts
ctx.tasks.submit(async (task) => {
  // Flips working → input_required, escalates the request up the
  // ownership chain to the connected client, resolves with the answer,
  // and restores working — all in one call.
  const approved = await task.elicit.confirm("Approve deploy to prod?");
  if (!approved) return [{ type: "text", text: "cancelled by operator" }];
  return deploy();
});
```

Each call composes `awaitingInput(escalate(request))`: the task flips to
`input_required`, the request **escalates as nested `inbox.ask`** to the
task's owning session (and, up the spawn lineage, ultimately the client),
and the answer threads back down the `ask` return stack. The escalation
relay is **payload-agnostic substrate** — this package takes no dependency
on `@agentick/elicitation-next`; the elicit sugar is injected by the
session that owns the harness.

`interactive ⊥ detached` — a **`detached: true`** task has no guaranteed
live ancestor chain to reach the client, so `ctx.elicit` (and the
underlying `awaitingInput`) **throw** `DetachedTaskCannotElicitError`
rather than hang. Detached means non-interactive, fire-and-forget,
durable-result work.

> **Tier.** T1 (this release) wires the root-session case: a task in a
> connected session escalates to that session, which resolves terminally
> against the real client elicitation. Deeper bubbling — a **sub-agent**
> session forwarding to its spawner, ancestor **interception**, and the
> **cross-process** (child-executor) elicit bridge — is **ADR 69 T2**
> (seam built, `TODO(ADR-69 T2)` trailheads in place). See
> [ADR 69](../../docs/proposals/v2/blueprint/69-request-escalation.md).

Verified by `src/__tests__/escalation.spec.ts` (origin guards) and
`@agentick/session-next`'s `src/__tests__/escalation.spec.ts` (the
root-session round-trip + FSM flip).

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

#### `TaskHandle` IS the canonical `OperationHandle` shape

Per the v2 audit (#291), `TaskHandle` is the canonical shape for any
long-running operation handle in the framework. New surfaces that
need lifetime management should adopt the same six-field convention:

| Concern          | Field                                                          |
| ---------------- | -------------------------------------------------------------- |
| Identity         | `taskId` (rename to `opId` / `handleId` for non-task surfaces) |
| Initial status   | `initialStatus`                                                |
| Result           | `result: Promise<T>`                                           |
| Live snapshot    | `info()`                                                       |
| Streaming events | `events(): AsyncIterable<...>`                                 |
| Cancellation     | `cancel(reason?)`                                              |

Operations that are bounded request/response (e.g., `sandbox.exec`,
`mcp.callTool`) intentionally return `Promise<Result>` without a
handle — there's nothing to manage between request and response.
The handle shape is for work where the caller may want to observe
progress, cancel mid-flight, or persist across boundaries.

### Lifetime semantics (ADR 68)

`TasksHarness` is per-session (#159), but the `TaskStore` is
app/gateway-scoped:

- **Per-task**: `handle.cancel(reason?)` applies the `cancelled`
  transition, aborts the AbortSignal, and (Effect path) interrupts the
  work fiber via `Fiber.interrupt` — `await cancel()` waits for
  finalizers (settled-cancel).
- **Per-session (default, `detached: false`)**: `harness.close()`
  cancels ALL non-detached in-flight tasks via the cascading interrupt
  path — today's behavior, IDENTICAL.
- **Detached (`submit(work, { detached: true })`)**: NOT aborted on
  session close. The executor keeps running and the record persists in
  the shared app-scoped store, so the session can stop and the task
  continues — as long as the app process is alive (with the in-memory
  store). Survival across app-process **restart** needs a durable store
  (`@agentick/tasks-postgres-next`, same port, not built here).
- **Orphan accounting (`interrupted`)**: on construction the harness
  reads its scope-filtered store records; any still-`working` record
  with no reattachable executor is marked `interrupted` (a lost
  in-process fiber can't reattach). With the in-memory store this is a
  same-process no-op; the durable store exercises it across restart.

Truly **distributed** execution (a task running on a different node) is
the ambitious tier — a distributed-worker `TaskExecutor` + a shared
store — and is not built here. The seam is ready for it.

### Lookups by id

`get(id)`, `status(id)`, `result(id)`, `cancel(id, reason?)`,
`events(id)`. All throw `UnknownTaskError` (`_tag`-discriminated) for
unknown ids — same shape across local and cluster paths.

### `TaskStatus`

`"working" | "input_required" | "completed" | "failed" | "cancelled" |
"interrupted"`. The first five map 1:1 to MCP's task FSM.
`input_required` is a **live, produced** state: a work fn opts in by
wrapping an external-input pause in
[`ctx.awaitingInput`](#awaitinginput--pause-on-external-input-input_required),
which flips `working → input_required → working` and surfaces on the bus +
the MCP wire. `interrupted` (ADR 68) is the orphan-accounting terminal — a `working`
record whose live executor is gone (harness re-hydrated a store record
with no reattachable execution). It has **no MCP-wire representation**
(the MCP enum stops at `cancelled`); the server codec lossy-maps it to
`failed` at the wire boundary.

### `TaskStore`, `TaskExecutor` (ADR 68)

The durability + execution seams. Port types in `@agentick/spec-next`,
re-exported here; bundled impls (`InMemoryTaskStore`,
`InProcessTaskExecutor`) exported from the package root.

```ts
import {
  InMemoryTaskStore,
  InProcessTaskExecutor,
  runTaskStoreConformance,
  type TaskStore,
  type TaskExecutor,
} from "@agentick/tasks-next";

// Inject a custom store + executor registry at construction:
new TasksHarness(id, journal, bus, inbox, { store, executors: [childExecutor] });
```

`TaskStore` — `put` / `get` / `list(query?)` / `delete` / `prune?` +
`backend`. `TaskExecutor` — `start(record, work, report, signal)` →
`TaskExecution`, `reattach?`, `cancel(exec, reason?)`. Any custom store
proves compliance via `runTaskStoreConformance({ label, factory })`.

#### Build your own store — back tasks with your stack

The record is the **source of truth**, so `put` is a whole-record upsert on
every transition; reads serve `get` / `list`. The in-memory default is just
one impl — a SQL, Redis, or DynamoDB store swaps in identically.

```ts
import type { TaskStore, TaskRecord, TaskStoreQuery } from "@agentick/tasks-next";
import { runTaskStoreConformance } from "@agentick/tasks-next";

class SqlTaskStore implements TaskStore {
  readonly backend = "sql";
  constructor(private readonly db: Db) {}

  put(r: TaskRecord) {
    return this.db.upsert("tasks", r.taskId, r);
  } // full record
  get(id: string) {
    return this.db.find("tasks", id);
  }
  list(q?: TaskStoreQuery) {
    return this.db.query("tasks", q?.scope, q?.status);
  }
  delete(id: string) {
    return this.db.remove("tasks", id);
  }
  prune(before: number) {
    return this.db.removeTerminalsBefore("tasks", before);
  }
}

// Prove it with the SAME suite the in-memory default passes:
runTaskStoreConformance({ label: "sql", factory: () => new SqlTaskStore(testDb()) });
```

#### Build your own executor — run work where you want

`report` is the **one path back**: every transition (progress, terminal)
flows through it → the harness persists the record + emits the events.
`reattach` re-adopts a still-running job after a restart (durability); return
`undefined` and the harness marks the orphan `interrupted`.

```ts
import type {
  TaskExecutor,
  TaskExecution,
  TaskRecord,
  TaskWork,
  TaskReport,
} from "@agentick/tasks-next";

class QueueTaskExecutor implements TaskExecutor {
  readonly kind = "queue";
  constructor(private readonly queue: Queue) {}

  start(
    record: TaskRecord,
    _work: TaskWork,
    report: TaskReport,
    signal: AbortSignal,
  ): TaskExecution {
    const job = this.queue.enqueue(record.handlerRef!, record.input);
    job.onProgress((progress) => report({ progress }));
    job.onDone((result) => report({ status: "completed", result }));
    job.onError((e) => report({ status: "failed", failure: { kind: "error", reason: String(e) } }));
    signal.addEventListener("abort", () => this.queue.cancel(job.id));
    return { kind: this.kind, jobId: job.id }; // → persisted on record.executorState
  }

  reattach(record: TaskRecord, report: TaskReport): TaskExecution | undefined {
    const jobId = (record.executorState as { jobId?: string }).jobId;
    const job = jobId ? this.queue.adopt(jobId) : undefined; // still alive after restart?
    if (!job) return undefined; // gone → harness marks it `interrupted`
    job.onDone((result) => report({ status: "completed", result }));
    return { kind: this.kind, jobId };
  }

  cancel(exec: TaskExecution, reason?: string): void {
    this.queue.cancel((exec as { jobId: string }).jobId, reason);
  }
}
```

The bundled `ChildProcessTaskExecutor` (below) is a worked instance of exactly
this seam; a `@agentick/tasks-postgres-next` store is a worked instance of the
store port.

## Executor registry + selecting an executor (ADR 68 Build B)

An app runs MOST tasks in-process (cheap — a fiber) and opts SPECIFIC tasks out
to an isolated child (crash-risky / CPU-heavy work). The harness holds a
**registry of executors keyed by `.kind`**; a submit selects one **per task**
via `executorKind` (omitted → `"in-process"`, the bundled default). Hydration
and cancel dispatch on the record's `executorKind`.

The registry is the bundled in-process default MERGED with the provided list —
a provided executor wins on `.kind` collision, and each entry is keyed by its
own self-reported `.kind` (you never write a `Record` whose keys duplicate
`.kind`):

```ts
// App-scoped wiring (createApp) — NOT a cascade. Detached tasks + child
// reattach need shared singletons that outlive any one session, so the
// store + executors are owned by the app for its whole lifetime.
createApp(RootAgent, {
  model,
  reconciler,
  tasks: {
    // store defaults to a node-local InMemoryTaskStore; swap a durable one.
    executors: [
      new ChildProcessTaskExecutor({
        workerModule: path.resolve("./dist/task-worker.js"),
      }),
    ],
  },
});
```

Select per submit from a tool handler:

```ts
// in-process (default) — a closure runs on the main event loop
ctx.tasks.submit(async ({ onProgress }) => {
  onProgress({ current: 1, total: 1 });
  return [{ type: "text", text: "done" }];
});

// child-process — a by-ref submit; no closure crosses the boundary
ctx.tasks.submit({ executorKind: "child-process", handlerRef: "deploy", input });
```

A submit routed to a by-ref executor (`byRef: true`) without a `handlerRef`
throws `TaskHandlerRefRequiredError` at `submit`, before anything forks; an
unregistered `executorKind` throws `UnknownTaskExecutorError`.

## The child-process executor (ADR 68 Build B)

`ChildProcessTaskExecutor` (`byRef = true`) forks a Node child per submit for
**execution isolation** and — because the store is app-scoped — survival of the
spawning session's close. A closure can't cross a process boundary, so the
executor IGNORES the `work` closure and hands the child a **serializable
descriptor** (the `TaskRecord` — `handlerRef` + `input` live on it). The child
resolves the handler from a registry, runs it, and reports
status / progress / result back over IPC → parent → the uniform `report` seam.

**The worker-module pattern.** The adopter authors a `workerModule` — register
handlers, then call `runTaskWorker()`:

```ts
// task-worker.ts — the adopter's workerModule
import { registerTaskHandler, runTaskWorker } from "@agentick/tasks-next";

registerTaskHandler<{ target: string }>("deploy", async (ctx, input) => {
  ctx.onProgress({ current: 0, total: 1, message: `deploying ${input.target}` });
  await deploy(input.target, ctx.signal); // honor the abort signal for cancel
  return [{ type: "text", text: "deployed" }];
});

runTaskWorker(); // one fork = one task; reports the terminal transition, exits
```

`registerTaskHandler` + `TaskHandlerRegistry` are **transport-agnostic** —
resolve-work-by-ref with input/result generics the non-generic `TaskExecutor`
port can't give. `runTaskWorker` is the child-process-IPC driver bolted on top;
a future distributed executor reuses the SAME registry + `(ctx, input) => …`
contract with its own driver (a queue-consumer loop) in place of it.

**The adopter owns the loader.** `forkOptions` is passed straight to `fork` —
the executor hardcodes no `execArgv`. A built JS worker needs nothing; a TS
worker under `tsx` passes `{ execArgv: ["--import", "tsx"] }`.

**Constraint (by-ref).** No closures cross the boundary — work is resolved from
`handlerRef`. Both `input` and the returned result cross by **V8 structured
clone** (the executor forks with `serialization: "advanced"` — so `Date`,
`Map` / `Set`, `Buffer` / typed-arrays survive intact, which matters for image /
binary `ContentBlock` results; functions and class prototypes do NOT). Override
`forkOptions.serialization` if you need JSON-wire semantics. `TaskFailure.cause`
is deliberately NOT sent (an arbitrary thrown value may not clone) — failures
lossy-encode to `reason`, the same wire-boundary asymmetry the MCP codec
documents.

**What it delivers vs. defers.** Delivers: isolation, independent killability
(graceful IPC-cancel → `SIGKILL` backstop after `killGracePeriodMs`), crash →
`failed` (a child that dies mid-work surfaces honestly), and — because the
executor instance is app-scoped — a `detached` child that survives its
session's close and can be reattached WITHIN the app process. Defers: reattach
across **app-process restart** (needs a durable store + the child pid on
`record.executorState` — `TODO(ADR-68 pg)`).

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
`TasksHarnessProtocol` impl through the protocol suite covering: submit
→ result, work-fn errors, cancel, progress envelope, events stream,
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
- **Persistence across process restart** — the bundled
  `InMemoryTaskStore` is node-local + lost on process exit. `detached`
  tasks survive their spawning session's close (same process), but
  survival across an app-process restart needs a durable store
  (`@agentick/tasks-postgres-next`, same `TaskStore` port — not built
  here). The `interrupted`-on-hydration logic is wired and ready for it.
- **The child-process / distributed executors** — ADR 68 Build B and
  the ambitious tier. They implement the same `TaskExecutor` seam; not
  built here.
- **ToolExecutor return-shape detection** — the executor's logic for
  detecting a `TaskHandle` return and branching on `taskSupport`
  lives in `@agentick/tool-executor-next` (#156).

## Verified by

- `src/__tests__/harness.spec.ts` — 30 tests covering submit /
  result / progress envelope / cancel / close / events / errors /
  identity / subscriber fan-out / synchronous-first-tick abort
  semantics / Effect-typed work (interrupt, Cause handling, settled
  cancel). The bus-envelope tests pin the byte-identical
  `task-status` / `task-progress` wire payloads (ADR 68 parity gate).
- `src/__tests__/store.spec.ts` — 15 tests: `runTaskStoreConformance`
  against `InMemoryTaskStore` (10) + the ADR 68 durability behaviors —
  detached-survives-close (non-detached still aborts), every-transition
  persisted, shared-store cross-session isolation, and
  `interrupted`-on-hydration (orphaned `working` → `interrupted`;
  terminal prior-run records surfaced read-only).
- `src/__tests__/input-required.spec.ts` — the `awaitingInput` seam on the
  in-process executor: the full `working → input_required → working →
  completed` status timeline (bus envelopes) with the paused-state
  statusMessage, the durable `TaskStore` record reflecting `input_required`
  while paused, and cancel-while-paused landing terminal `cancelled` (the
  `finally`'s `working` report proven a post-terminal no-op).
- `src/__tests__/child-executor.spec.ts` — 13 tests that ACTUALLY fork a
  `tsx`-loaded child and round-trip over IPC (no fakes for the process
  boundary): echo result round-trip, ordered progress over IPC, thrower →
  `failed`, graceful cancel (child exits), `SIGKILL` backstop for a child
  that ignores cancel, `TaskHandlerRefRequiredError` on a by-ref submit
  without `handlerRef` (before forking), `UnknownTaskExecutorError` on an
  unregistered kind, registry merge (in-process + child both resolvable),
  detached-survives-`close()` + reattach-within-process + cancel,
  non-detached killed on `close()`, and `awaitingInput` flipping
  `input_required → working → completed` over IPC (message-triggered
  release — deterministic, real fork).
- `src/__tests__/executor-conformance.spec.ts` — `runTaskExecutorConformance`
  green for BOTH bundled strategies: `InProcessTaskExecutor` (closures) and
  `ChildProcessTaskExecutor` (by-ref over a real fork). The proof the seam
  is honestly uniform.
- `src/__tests__/cluster-inbox.spec.ts` — 6 tests covering
  cluster-portable cancel / get / result via inbox addressing.
- `src/__tests__/conformance.spec.ts` — drives
  `runTasksHarnessConformance` against `TasksHarness` (17 protocol
  tests) — the in-process default is behavior-identical to pre-ADR-68.
- `src/__tests__/session-tasks-tools.spec.ts` — 19 tests covering
  every model-facing tool's handler directly (no tool-executor in
  the dep tree to avoid `tasks ↔ tool-executor` cycle): list / get
  / cancel / await against known + unknown ids, structured failure
  shape, bundle structural assertions, sessionId-scoped handler
  refs, extension factory smoke.
- `packages-next/tool-executor/src/__tests__/task-handle.spec.ts`
  (sibling package) — `ctx.tasks` wiring, Pattern A (await
  transparently), Pattern B (return task-ref), and abort propagation
  from dispatch into the in-flight task.
- `packages-next/mcp/src/__tests__/task-bridge.spec.ts` +
  `mcp/src/server/__tests__/tasks-projection.spec.ts` (sibling
  package) — the MCP wire round-trip is unchanged under the refactor
  (byte-identical `task-status` / `task-progress` payloads), plus a
  PRODUCED `input_required` projecting onto the wire (`tasks/get`
  reports the paused state a task entered via `ctx.awaitingInput`).

## Roadmap & known gaps

- **ADR 68 pg (`@agentick/tasks-postgres-next`)** — LANDED. A durable
  `TaskStore` conforming to the same port; adds cross-app-restart record
  durability and is what actually exercises the `interrupted`-on-hydration
  path (proven against a real postgres). Cross-restart *child reattach* is
  NOT unlocked by durability alone and is NOT a fork-IPC follow-on: a fresh
  process cannot re-attach to a child spawned by the dead parent (fork IPC is
  a non-reconnectable spawn-time pipe), so a persisted pid buys no channel.
  A worker whose reports outlive its parent must report via a reconnectable
  transport (shared store / cluster bus) — the **distributed-executor tier**
  below. Across a restart the child-process executor's honest outcome is
  `interrupted`; its worker self-terminates on IPC `disconnect`.
- **Phase D (Effect-native internals, #155)** — convert the
  per-subscriber `Queue<TaskEvent>` fan-out to `Stream.fromQueue`,
  expose an `Effect<TaskHandle>` work overload that runs as a real
  interruptible fiber.
- **`taskSupport: "supported"`** — the caller-choice mode declared in
  the spec annotation but not yet branched on by the executor. Lands
  alongside Phase C, where the model has the tooling to opt in.

@see [`docs/proposals/v2/blueprint/23-mcp-as-harness.md`](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md) §Tasks
@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
