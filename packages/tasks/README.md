# @agentick/tasks

**A task is a persisted state machine, not a promise you're holding.** Long-running work — a slow shell command, a deploy step, a multi-minute completion — is submitted as a record in a store, and _how_ it runs is a swappable strategy behind that record. The consequence: a task survives the session that started it, its lifecycle is journaled, and a client that connects halfway through still sees it.

Everything else follows from that inversion. Cancellation is address-routed rather than object-routed, so it works across a cluster. Resume is honest rather than optimistic — a `working` record whose executor is gone becomes `interrupted`, never silently `completed`. And because the record is the truth, the states MCP names (`working`, `input_required`, `completed`, `failed`, `cancelled`) are the states here, so the wire codec is a pass-through.

## Install

```bash
npm install @agentick/tasks
```

Subpaths: `/client` (browser-side handle + view), `/testing` (doubles + three conformance suites).

## Quick start

Install the extension, then submit from any tool handler. `ctx.tasks` is dispatch-resolved, so the handler reaches the session's harness instance without capturing anything at render:

```ts
import { withTasks } from "@agentick/tasks";
import type { SessionExtension, ToolHandler } from "@agentick/spec";

// Session extension — also registers the four model-facing task_* tools.
const extensions: SessionExtension[] = [withTasks()];

export const deployHandler: ToolHandler = async (input, { ctx }) => {
  const { target } = input as { target: string };

  const handle = ctx.tasks!.submit(async (task) => {
    task.setStatusMessage(`deploying ${target}`);
    const bar = task.progress.begin({ total: 3 });
    for (let step = 0; step < 3; step++) {
      task.signal.throwIfAborted();
      await runStep(step, target);
      bar.advance();
    }
    return [{ type: "text" as const, text: `deployed ${target}` }];
  });

  return handle; // the model gets a task ref, not a blocked tick
};
```

Returning the handle is the interesting half: the tool executor turns it into a `session_task_ref` content block, the tick ends, and the model manages the task across later ticks with the tools below. Returning `await handle.result` instead blocks the tick and the model never learns a task existed. Both are legitimate.

Declaring the tool around that handler is [@agentick/compiler-react](../compiler-react)'s `createTool`; nothing below depends on which declaration surface you use.

## Two shapes, one submit

| Return                | What the model sees                                               |
| --------------------- | ----------------------------------------------------------------- |
| `await handle.result` | Ordinary tool output. It never knows this was a task.             |
| `handle`              | A `session_task_ref` block, plus the `task_*` tools to act on it. |

The choice is per call and the harness behaves identically either way — same record, same journaling, same channels. Which one a tool gets can also be driven by its `taskSupport` annotation; see [@agentick/tool](../tool).

## The model-facing tools

`withTasks()` registers four, scoped explicitly in their descriptions to framework-spawned background tasks so they never read as a todo-list API:

| Tool          | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `task_list`   | Discover in-flight and recently terminal tasks, local plus remote.       |
| `task_get`    | Poll one task's `TaskInfo`.                                              |
| `task_cancel` | Abort an in-flight task. Idempotent.                                     |
| `task_await`  | Block this tick until terminal — the escape hatch back to inline output. |

Without them a task ref is inert: the model receives an id it cannot act on. Pass `withTasks({ registerModelTools: false })` for a headless server driving tasks entirely from adopter code.

`task_list` also enumerates tasks living on connected MCP servers. It looks up the `mcp` namespace at call time — so install order between `withTasks()` and `withMCP()` doesn't matter — and returns `{ tasks, remote }` where each `remote` entry carries either that server's tasks or an `error` string. One unreachable server degrades its own row instead of blanking the listing.

## Waking the model when a task finishes

A backgrounded task that completes while nothing is watching is a dead end: the model moved on and will never poll. A `wake` policy closes it by synthesizing **exactly one** follow-up send into the owning session — a real, journaled execution.

```ts
// Default wake: bounded metadata (task id, status, duration). Never raw output.
ctx.tasks!.submit(work, { wake: true });

// Or shape it — and return null to suppress.
ctx.tasks!.submit(work, {
  wake: (outcome) =>
    outcome.status === "failed"
      ? {
          messages: [
            { role: "user" as const, content: `Deploy failed: ${outcome.failure?.reason}` },
          ],
        }
      : null, // successes stay quiet
});
```

> [!IMPORTANT]
> The wake is **consumed on observe**. If the model called `task_await`, or called `task_get` and saw a terminal state, or the task was cancelled, the wake never fires. Exactly one of {observed in-band, woken out-of-band} happens — there is no path to both.

The default is off, because waking interrupts. Flip it for a whole session with `defaultWake`, and a per-task `wake: false` still overrides. A wake carries identity and outcome only; the model fetches actual output through `task_get` or `task_await` if it wants it, which is what stops a background task from injecting arbitrary content into the window.

Wake policy is process-local runtime state. It isn't persisted on the record and doesn't survive rehydration — a detached task that outlives its process won't wake, though its completion is still readable from the store.

## Pausing for input

Wrap any external wait in `awaitingInput` and the task flips `working → input_required → working` for its duration, so observers — a UI, an MCP client, the model — can tell "blocked, provide something" from "actively working":

```ts
ctx.tasks!.submit(async (task) => {
  const approval = await task.awaitingInput(waitForWebhook(), { message: "awaiting approval" });
  return [{ type: "text" as const, text: `approved by ${approval.who}` }];
});
```

`working` is restored in a `finally`, so a throw or a cancel can't strand the task. Hand it an `Effect` instead of a promise and the pause becomes a real interruptible child fiber bound to the task's signal — `Effect.sleep`, finalizers, and `onInterrupt` actually unwind on cancel, which a promise that merely receives a flag cannot do.

`task.elicit` is the same mechanism aimed at a person. It escalates up the ownership chain to the owning session and its client, then resolves with the answer:

```ts
ctx.tasks!.submit(async (task) => {
  const ok = await task.elicit.confirm("Deploy to production?");
  if (!ok) return [{ type: "text" as const, text: "cancelled by operator" }];
  return runDeploy();
});
```

> [!WARNING]
> `elicit` and `awaitingInput` throw on a `detached: true` task. Detached work has no guaranteed live ancestor to reach a client, so it fails loudly rather than hanging against a dead address. Interactive and detached are mutually exclusive by construction.

Reaching a client requires an injected elicit factory (`buildElicit`). Every session built by `createApp` — and every bare session built by `buildSessionBridges` — is wired with it. A harness you construct yourself has no client unless you pass one, and `task.elicit` throws a "not configured" error there rather than pretending.

## Lifetime and durability

The store is app-scoped: one instance injected into every session's harness. That's what makes `detached` mean anything.

```ts
ctx.tasks!.submit(work, {
  detached: true, // not aborted when the spawning session closes
  ttl: 300_000, // failed with kind: "timeout" if still running after five minutes
});
```

Closing a session cancels its non-detached tasks with reason `harness_closed` and leaves detached ones running and persisted. On construction the harness reads its scope-filtered records back; a terminal record surfaces read-only, and a still-`working` record is offered to its executor's `reattach`. If nothing can reattach, it's marked `interrupted` — an outcome distinguishable from both success and failure.

With the bundled `InMemoryTaskStore` that survives session close but not process exit. Swap in [@agentick/tasks-store-postgres](../tasks-store-postgres) and it survives restart, at which point `interrupted` starts doing real work.

The store is a small port — `put`, `get`, `list(query)`, `delete`, an optional `prune`, plus the generic `query`/`mutate` seam. Certify your own:

```ts
import { runTaskStoreConformance } from "@agentick/tasks/testing";
import { myTaskStore } from "../src/index.js";

runTaskStoreConformance({ label: "my-store", factory: () => myTaskStore() });
```

`prune(before)` only ever removes terminal records. An in-flight task is never pruned no matter how old.

## Choosing where work runs

Executors are registered by their self-reported `kind` and selected per submit. `"in-process"` is always present; anything you supply merges over it.

```ts
import { ChildProcessTaskExecutor } from "@agentick/tasks";

const childExecutor = new ChildProcessTaskExecutor({
  workerModule: "/abs/path/to/worker.js",
  forkOptions: { execArgv: ["--import", "tsx"] }, // your build, your loader
  killGracePeriodMs: 5_000,
});
// → pass [childExecutor] as the harness's `executors`
```

A closure can't cross a process boundary, so out-of-process work is submitted **by reference** — no work function at all, just a `handlerRef` and the input to resolve it with:

```ts
ctx.tasks!.submit({
  executorKind: "child-process",
  handlerRef: "deploy",
  input: { target: "prod" },
});
```

The worker module registers handlers and hands control to the IPC driver:

```ts
// worker.ts — the file you pointed workerModule at
import { registerTaskHandler, runTaskWorker } from "@agentick/tasks";

registerTaskHandler<{ target: string }>("deploy", async (task, input) => {
  task.progress.begin({ total: 1, message: `deploying ${input.target}` });
  await runDeploy(input.target, task.signal);
  return [{ type: "text" as const, text: "deployed" }];
});

runTaskWorker(); // drives process.on("message"); one fork services one task
```

One fork per task, so crash-risky or CPU-heavy work can't corrupt a sibling and cleanup is just process exit. Cancel sends a cooperative message first and `SIGKILL`s after the grace period. Progress, status, `awaitingInput`, and `elicit` all cross the IPC boundary, so a child task is as interactive as an in-process one.

`registerTaskHandler` writes to a process-wide registry; `TaskHandlerRegistry` and `defaultTaskHandlerRegistry()` are there when you need isolated ones. The registry is transport-agnostic — resolve-work-by-ref is the reusable part, and `runTaskWorker` is only the child-process driver bolted onto it.

Pin a custom executor with the executor suite, which drives four canonical cases (`echo`, `progress`, `thrower`, `slow`) against a real instance:

```ts
import { runTaskExecutorConformance } from "@agentick/tasks/testing";

runTaskExecutorConformance({ label: "my-executor", setup: () => makeShell() });
```

## Watching a task

Every transition publishes on two channels — `task-status` carrying a `TaskInfo`, and `task-progress` carrying `{ taskId, progress, total?, message? }`. Two channels rather than one discriminated stream, so a task list and a progress bar can subscribe to different things.

In process, the handle is the stream. It opens with a synthesized snapshot and closes on the terminal frame:

```ts
for await (const event of handle.events()) {
  if (event.kind === "progress") render(event.progress, event.total);
  else if (event.kind === "status") setStatus(event.info.status);
}
```

### One progress grammar

A task's progress frame is a `ProgressUpdate` — `{ progress, total?, message? }` — the same three fields a tool's `ctx.progress` emits and the same three MCP's `notifications/progress` carries. Nothing is renamed at any boundary, so a progress bar written against one folds the other, and [@agentick/client-core](../client-core)'s `progressView` works on both.

Two doors into it, mirroring the tool side:

```ts
const bar = task.progress.begin({ total: rows.length }); // the everyday door
for (const row of rows) bar.advance(1, row.name);
bar.done();

task.onProgress({ progress: 12, total: 40 }); // the raw door — hand over a whole frame
```

The task's own id is the correlation token, so a work body never invents one. `begin()` emits an opening frame at zero, counts and clamps for you, and refuses to move backwards. Omit `total` when you genuinely don't know it — a spinner that tells the truth beats a fabricated denominator — and call `bar.total(n)` once if you learn it mid-flight.

Both doors funnel through the same report seam, so the durable record's progress fold, the `task-progress` channel, and the handle's event stream see identical frames whichever you use.

## The client side

`session.tasks` self-assembles on import — a live handle folding the `task-status` channel:

```ts
import "@agentick/tasks/client";

const tasks = client.session(sessionId).tasks;

tasks.subscribe(() => render(tasks.list())); // re-read on any change
tasks.get(taskId)?.status;
await tasks.cancel(taskId, "user cancelled");
```

The subscription **opens with a snapshot frame** carrying the full current task set, so a client connecting mid-run renders existing tasks rather than only ones that transition afterwards. Live deltas that follow are bare `TaskInfo` values, folded latest-wins by id.

`cancel` is fire-and-observe: it issues the RPC and resolves when the gateway accepts. The `cancelled` state arrives as an ordinary channel delta, never as a local hand-patch — state flows one way.

`taskStatusView(client, sessionId)` is the headless fold underneath, returning `get` / `subscribe` / `close` over a map keyed by `taskId`. Reach for it when composing rather than binding. Both `/client` exports depend only on the generic client, so neither drags the server runtime into a browser bundle.

## API

### `@agentick/tasks`

| Export                                                                                           | Purpose                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTasks(options?)`                                                                            | Session extension. Options: `registerModelTools`.                                                                                             |
| `TasksHarness` / `TasksHarnessOptions`                                                           | The implementation. Options: `parentScope`, `store`, `executors`, `buildElicit`, `defaultWake`, `inheritedInterceptors`, `interceptorParent`. |
| `InMemoryTaskStore`                                                                              | Bundled zero-dependency store. Lost on process exit.                                                                                          |
| `InProcessTaskExecutor`                                                                          | The default executor — Promise and Effect work in one fiber model.                                                                            |
| `ChildProcessTaskExecutor` / `ChildProcessTaskExecutorOptions`                                   | Fork-per-task isolation. Options: `workerModule`, `forkOptions`, `killGracePeriodMs`.                                                         |
| `registerTaskHandler` / `TaskHandlerRegistry` / `defaultTaskHandlerRegistry` / `TaskHandlerWork` | By-ref handler registration.                                                                                                                  |
| `runTaskWorker(registry?)`                                                                       | The child-side IPC driver.                                                                                                                    |
| `TASK_LIST` / `TASK_GET` / `TASK_CANCEL` / `TASK_AWAIT`                                          | The four model tool names.                                                                                                                    |
| `buildSessionTasksTools(sessionId, getNamespace?)`                                               | The declarations plus handlers, if you register them yourself.                                                                                |
| `TASK_STATUS_CHANNEL` / `TASK_PROGRESS_CHANNEL` (and `_FQN` variants)                            | Channel names, bare and fully qualified. `TaskStatusFrame` / `TaskStatusSnapshotFrame` are the shapes carried on the status channel.          |
| `TASKS_CANCEL_MESSAGE_TYPE` / `TASKS_GET_MESSAGE_TYPE` / `TASKS_RESULT_MESSAGE_TYPE`             | Inbox message types, with their payload and reply types.                                                                                      |
| `tasksWireExtension`                                                                             | Serves `tasks/cancel` over the gateway wire.                                                                                                  |
| `TASKS_EXTENSION_NAME`                                                                           | The extension's registered name.                                                                                                              |
| Port types (re-exported)                                                                         | `TaskStore`, `TaskStoreQuery`, `TaskRecord`, `TaskExecutor`, `TaskExecution`, `TaskReport`, `TaskTransition`, `TaskWork`.                     |

### `session.tasks`

| Member                    | Returns                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `submit(work, opts?)`     | `TaskHandle<T>`, **synchronously**. Work may be a Promise/sync function or an Effect.               |
| `submit(opts)`            | The by-ref form; `handlerRef` and `executorKind` are both required.                                 |
| `get(taskId)`             | `TaskInfo \| undefined`. A terminal read consumes a pending wake.                                   |
| `list()`                  | Every task this harness knows about.                                                                |
| `status(taskId)`          | `TaskStatus \| undefined`. Same consume-on-terminal semantics.                                      |
| `result(taskId)`          | Resolves on `completed`, rejects with a `TaskRejection` otherwise. Consumes the wake at invocation. |
| `cancel(taskId, reason?)` | Idempotent. Throws `UnknownTaskError` for an unknown id.                                            |
| `events(taskId)`          | `AsyncIterable<TaskEvent>`, closing on the terminal frame.                                          |

`TaskCreationInput`: `ttl`, `pollInterval`, `statusMessage`, `detached`, `input`, `handlerRef`, `executorKind`, `scope`, `wake`.

States: `working`, `input_required`, `completed`, `failed`, `cancelled`, `interrupted`. The first five map onto MCP one-to-one; `interrupted` has no wire representation.

Inside a work function, `ctx` carries the framework spine (`sessionId`, `log`, `trace`, `metrics`, `run`) plus `signal`, `onProgress`, `setStatusMessage`, `awaitingInput`, and `elicit`.

### `@agentick/tasks/client`

| Export                              | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `session.tasks`                     | Registered on import: `list`, `get`, `subscribe`, `cancel`, `close`. |
| `tasksHandle(client, sessionId)`    | The same handle, constructed explicitly.                             |
| `taskStatusView(client, sessionId)` | The headless fold: `get`, `subscribe`, `close`.                      |
| `TASK_STATUS_CHANNEL` / `_FQN`      | The channel names, for a consumer subscribing itself.                |
| `TASK_PROGRESS_CHANNEL` / `_FQN`    | Same, for progress.                                                  |

Types: `TaskStatusClient`, `TaskStatusMap`, `TasksHandle`, `TasksCommandClient`, `TaskStatusChannelName`, `TaskProgressChannelName`, `TaskStatusFrame`, `TaskStatusSnapshotFrame`. The channel names and frame shapes are re-exported here so a browser bundle never has to reach for the root barrel — which would drag the server harness in with them.

### `@agentick/tasks/testing`

| Export                       | Purpose                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `fakeTasks(options?)`        | A real harness on fresh in-memory substrate, plus its journal, bus, inbox, and `close()`. |
| `stubTasks(options?)`        | Canned answers for consumers that don't need a real registry.                             |
| `runTasksHarnessConformance` | Certify an alternate implementation.                                                      |
| `runTaskStoreConformance`    | Certify a store adapter.                                                                  |
| `runTaskExecutorConformance` | Certify an executor.                                                                      |

## Patterns

**Long-running tools.** [@agentick/tool](../tool) owns the `taskSupport` annotation and the `session_task_ref` block; [@agentick/tool-executor](../tool-executor) decides per call whether a handler yields inline output or a task ref.

**Approval and input.** [@agentick/elicitation](../elicitation) owns the prompt transport `task.elicit` escalates onto. This package takes no dependency on it — the factory is injected.

**Durability.** [@agentick/tasks-store-postgres](../tasks-store-postgres) implements `TaskStore` and passes the conformance suite. The generic `Store` seam and its shared suite skeleton live in [@agentick/store](../store).

**Wire.** [@agentick/gateway](../gateway) serves `tasks/cancel` through `tasksWireExtension`; the read half is the wired `task-status` channel.

**Remote tasks.** [@agentick/mcp](../mcp) publishes the namespace `task_list` reads for cross-server enumeration, and projects local tasks onto the MCP task wire.

## Roadmap & known gaps

- **`submit` has no interceptor seam.** It returns a handle synchronously — callers read `handle.taskId` immediately, and the executor must start before it returns — while the middleware seam is intrinsically async. Wrapping it would either break the synchronous contract or throw the moment any hook is registered, so guarding or transforming a submission isn't available.
- **No terminal-completion hook.** The more useful reactive seam ("react when the task actually finishes") sits on a synchronous callback path from the executor, and making it async would put the FSM ordering and the cancel-wins-the-race invariant at risk. Subscribe to the channels instead.
- **Store writes aren't awaited.** Persistence is write-through off the critical path, and a store failure is swallowed so it can't crash the harness. The in-memory default resolves synchronously so nothing is lost there, but a durable adapter wants a flush barrier and a typed write-failure surface, and neither exists.
- **A dropped wake is invisible.** Delivery swallows every error, not just the benign "session already gone" case, so a genuine delivery bug looks like a task that simply didn't wake.
- **No cross-restart child reattach.** Fork IPC is a spawn-time pipe a fresh process cannot rejoin, so a persisted pid buys nothing. After a restart the honest outcome for a child task is `interrupted`, and the worker self-terminates when IPC disconnects. Reattaching across restarts needs an executor that reports over a reconnectable transport.
- **`interrupted` is lossy on the MCP wire.** The MCP status enum stops at `cancelled`, so a codec crossing the wire maps it onto something less precise.

## Verified by

- `src/__tests__/harness.spec.ts` — the state machine end to end: submit through terminal, progress and status-message transitions, cancel winning the race against late work, ttl expiry, post-terminal reports as no-ops, close cancelling non-detached tasks while detached ones survive, the exact channel payload shapes, and `task.progress.begin()` publishing the unified grammar — determinate and indeterminate — down to the durable record's progress fold.
- `src/__tests__/conformance.spec.ts` + `conformance.ts` — the protocol invariants: round-trip, typed failure rejection, cancel and double-cancel idempotence, `UnknownTaskError` on unknown ids, snapshot and status reads, the event stream closing on terminal, and close semantics.
- `src/__tests__/store.spec.ts` + `store-conformance.ts` — put/get round-trip, upsert in place, scope- and status-filtered `list`, delete, and prune restricted to terminal records; plus the ttl reaper's lifetime across `close()` — a surviving detached task keeps its deadline, and cancelling one disarms the reaper so the deadline never rewrites the outcome.
- `src/__tests__/close-teardown.spec.ts` — teardown isolation: the harness releases its inbox address whether or not the close cancel cascade succeeds (an executor whose `cancel` rejects, a store whose write-through rejects), the ttl sweep after a failed cancel still disarms the reaper, the failure is still reported rather than swallowed, a second close is a no-op, and a close that races construction releases what it claimed. Without it the address stayed claimed and the next session on that id could not register.
- `src/__tests__/executor-conformance.spec.ts` + `executor-conformance.ts` — the four canonical cases against the in-process executor, including ordered progress delivery and cancellation of work that honors its signal.
- `src/__tests__/child-executor.spec.ts` — fork-per-task lifecycle, by-ref handler resolution, progress and status over IPC, cooperative cancel with the `SIGKILL` backstop, and terminal-send flush discipline.
- `src/__tests__/input-required.spec.ts` — `awaitingInput` flipping `working → input_required → working`, restoration on throw, and the Effect overload interrupting on cancel.
- `src/__tests__/escalation.spec.ts` + `child-elicit.spec.ts` — `task.elicit` escalating to the owning session and resolving with the answer, in process and across IPC, plus the detached-task rejection. `@agentick/app`'s `src/__tests__/tasks-elicit.spec.tsx` pins the same round trip through real `createApp` wiring, where the harness is constructed by the app rather than by the session bridges.
- `src/__tests__/task-wake.spec.ts` — exactly-once wake, consume-on-observe from `task_get`, `task_await`, and cancel, the callable policy shaping and suppressing, `defaultWake` with a per-task override, and no wake during close.
- `src/__tests__/task-tools.spec.ts` — the four tools' declarations and handlers, including unknown-id responses and the `remote` slot's per-server error capture.
- `src/__tests__/cluster-inbox.spec.ts` — the three inbox verbs routing cancel, get, and result by address, with replies over `request-response`.
- `src/__tests__/wire.spec.ts` — `tasks/cancel` resolving its session through the gateway and returning no state.
- `src/__tests__/command-hooks.spec.ts` + `ctx-spine.spec.ts` — inherited interceptors reaching this harness's operations, and the context spine a work body receives.
- `src/client/__tests__/tasks-handle.spec.ts` + `tasks-handle.conformance.spec.ts` + `session-tasks.spec.ts` + `task-status-view.spec.ts` — the opening snapshot seeding the set, latest-wins delta folding, reference stability between changes, `cancel` issuing the RPC without hand-patching, and `session.tasks` self-registration.
