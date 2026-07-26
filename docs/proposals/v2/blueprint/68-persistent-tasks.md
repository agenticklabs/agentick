# ADR 68 — Persistent tasks: record-as-source-of-truth + pluggable executors + TaskStore

**Status:** ACCEPTED 2026-07-08 (Fable, for Ryan). **Builds on:** the `TasksHarness`
(in-flight registry), `TimelineStore` (the swappable durable-store pattern, #132), sandbox
microVMs (ADR 60 / #223), dispatch idempotency (#34), the cluster substrate-wrapping layer.
**Realistic tier of the three-tier plan; architected as the on-ramp to the ideal + ambitious
tiers.**

## The pivot: the durable record is the source of truth; the executor is pluggable

Today a task IS an in-process fiber and the record is a view. Invert it:

- A task is a persisted **`TaskRecord`** — a state machine
  (`working | input_required | completed | failed | cancelled | interrupted`) living in a
  **`TaskStore`**.
- **How it runs** is a swappable **`TaskExecutor`** strategy behind the record (in-process
  fiber now; child-process now; sandbox / distributed worker later).
- The `TasksHarness` orchestrates: on `submit` it writes a `working` record + starts an
  executor; the executor **reports transitions** back; the harness persists each transition
  to the store AND emits the existing `tasks-status` / `tasks-progress` bus events. The bus
  stays the LIVE plane; the store is the DURABLE plane.

Build this seam once and the ideal (detached, resumable) and ambitious (distributed) tiers
are added executor strategies + a durable store, not rewrites.

## `TaskStore` protocol (CRUD port — mirrors `TimelineStore`)

```ts
interface TaskRecord {
  readonly taskId: string;
  readonly status: TaskStatus; // + "interrupted" (new)
  readonly scope: EventScope; // owner: session/execution/principal
  readonly executorKind: string; // "in-process" | "child-process" | ...
  readonly detached: boolean; // survives spawning-session close?
  readonly input?: unknown; // submit input (audit / replay)
  readonly handlerRef?: string; // for executors that resolve work by ref (child/worker)
  readonly result?: readonly ContentBlock[]; // on completed
  readonly failure?: TaskFailure; // on failed/cancelled
  readonly progress?: { progress: number; total?: number; message?: string };
  readonly executorState?: unknown; // reattach handle (child pid, microvmId, …)
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface TaskStore {
  put(record: TaskRecord): Promise<void>; // upsert on every transition
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(query?: TaskStoreQuery): Promise<readonly TaskRecord[]>; // by scope / status
  delete(taskId: string): Promise<void>;
  prune?(before: number): Promise<void>; // optional GC of terminals
}
```

Swappable + conformance-parameterized (`runTaskStoreConformance(factory)`), exactly like the
timeline stores. **Ship the in-memory default now; a `@agentick/tasks-store-postgres` conforms
to the SAME protocol later — not built here.** No `subscribe` on the store — liveness is the
bus; the store is CRUD + re-hydration.

## `TaskExecutor` seam (pluggable strategy)

```ts
interface TaskExecutor {
  readonly kind: string;
  start(
    record: TaskRecord,
    work: TaskWork,
    report: (u: TaskTransition) => void,
    signal: AbortSignal,
  ): TaskExecution;
  reattach?(record: TaskRecord, report: (u: TaskTransition) => void): TaskExecution | undefined;
  cancel(exec: TaskExecution, reason?: string): void;
}
```

`report` is the ONE uniform reporting path; the harness turns each transition into a
`store.put` + a bus emit. This is what keeps executors interchangeable.

### Executor 1 — in-process (default; the current model, refactored)

Runs `work()` as a Promise/Effect fiber, `AbortController`-cancellable. `report` is a direct
call. `reattach` returns `undefined` — a lost fiber can't be re-attached, so on restart the
harness marks its `working` record **`interrupted`** (honest, not silently lost). This is the
refactor of today's `TasksHarness` execution onto the record/report seam.

### Executor 2 — child-process (isolation; on-ramp to detached/distributed)

Forks a child Node process, hands it a **serializable descriptor** (`handlerRef` + `input`);
the child resolves the handler from a registry, runs it, and reports status/progress/result
back over **IPC → parent → `report`**. Constraint (state it plainly): child tasks require a
**registered, referenceable handler** — not an inline closure (closures can't cross the
process boundary), same shape as tool `handlerRef`. What it delivers with the in-memory store:
**execution isolation** (CPU-heavy / crash-risky work off the main event loop, independently
killable) and, because the store is app-scoped, survival of the spawning session's close. It
is the template the sandbox / distributed-worker executors follow later; with a shared/durable
store it additionally supports reattach (child writes directly / parent re-attaches by pid).

## Lifetime: store is APP/GATEWAY-scoped → detached tasks survive session close

The `TaskStore` lives at app/gateway scope (shared across sessions), not per-session. A
session's `TasksHarness` reads/writes the shared store, scope-filtered to its own tasks.
`submit(work, { detached?: boolean })`:

- default (`detached: false`) — aborted on the spawning session's `close()` (today's behavior);
- `detached: true` — NOT aborted on session close; the executor + record persist independently
  (answering "the session can stop and it continues" — as long as the app process is alive
  with the in-memory store; across app restart requires a durable store, below).

## What the in-memory milestone delivers vs. defers (honest)

- **Delivers now:** the record/executor architecture (the on-ramp); an app-scoped durable-
  _within-a-run_ ledger; `detached` tasks that outlive their session; two execution strategies
  (in-process, child-process-for-isolation); `interrupted` accounting; cross-node observe +
  cancel for free (cluster-wrapped inbox/bus — see below).
- **Defers (seam ready):** durability across **app-process restart** + **reattach** (needs a
  shared/durable store — pg — which conforms to the same protocol); truly **distributed
  execution** (the ambitious tier's worker/queue + a distributed executor).

## Cluster integration (confirmed — free for the control plane)

`TasksHarness` is a `BaseHarness`; the cluster is a substrate-wrapping layer providing a
cluster-aware bus + inbox, and harness addresses (`tasks:${scopeId}`) are cluster-portable. So
when the app is clustered, `tasks-get` / `tasks-cancel` inbox messages and `tasks-status`
events route cross-node automatically — a task submitted on node A is observable + cancellable
from node B **with no task-specific work**. Execution remains node-local (the fiber/child runs
where submitted); cross-node _execution_ is the ambitious distributed-worker tier. The
in-memory store is node-local; a shared store (pg) is what lets another node read the record.

## Build scope (this ADR → one build)

1. spec: `TaskRecord`, `TaskStore`, `TaskExecutor`, `TaskTransition`, `TaskStoreQuery`,
   `interrupted` status; `runTaskStoreConformance(factory)`.
2. `InMemoryTaskStore` (default) + conformance green.
3. Refactor `TasksHarness` to record-source-of-truth: submit → `store.put(working)` + executor
   start; transitions → `store.put` + bus emit; `list`/`get` read the store; `detached` opt-out
   of close-abort; `interrupted` on restart-without-reattach.
4. `InProcessTaskExecutor` (default) + `ChildProcessTaskExecutor` (registered-handler + IPC).
5. Parity: every existing `TasksHarness` test green (in-process default is behavior-identical);
   new: store conformance, detached-survives-close, child-process round-trip, interrupted-on-
   restart, cross-node cancel (clustered, if feasible in-test).
   Deferred, seam-ready: `@agentick/tasks-store-postgres`; sandbox + distributed-worker executors;
   reattach-across-app-restart.
