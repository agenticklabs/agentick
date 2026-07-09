# @agentick/tasks-store-postgres-next

**Postgres** `TaskStore` adapter — the durable, flexible **cloud pole** of
the persistent-task substrate from
[ADR 68, "persistent tasks"](../../docs/proposals/v2/blueprint/68-persistent-tasks.md).
Sibling of [`@agentick/timeline-postgres-next`](../timeline-postgres); same
escape-hatch surface, same BYO-pool discipline.

The bundled [`InMemoryTaskStore`](../tasks/src/store.ts) is `:memory:` — task
records die with the process. This adapter makes them **durable across
app-process restart**, which is the whole point of ADR 68's record-as-source-
of-truth pivot: a task is a persisted `TaskRecord` state machine, not an
in-process fiber, so a fresh `TasksHarness` over the same table can pick up
where a dead process left off.

## What it unlocks

Three behaviors the in-memory store structurally cannot demonstrate (they are
same-process no-ops there):

- **Durable records across restart.** Every FSM transition upserts the full
  record; it survives the process that wrote it.
- **`interrupted`-on-restart, for real.** On construction a `TasksHarness`
  hydrates its scope's records and marks any orphaned `working` record whose
  in-process fiber died `interrupted` (the in-process executor can't reattach
  a lost fiber). With a durable store this is honest cross-restart orphan
  accounting, not a same-process no-op.
- **Terminal adoption across restart.** A task that `completed` in the old
  process is hydrated by the new one; `harness.result(taskId)` returns the
  stored result blocks decoded from `jsonb`, not from a live fiber.

## Purpose

Persist the task FSM to Postgres. The `payload` `jsonb` column is the
**authoritative full `TaskRecord`**; `scope` (`jsonb`), `status` (`text`), and
`updated_at` (`bigint`) are **denormalized projections** re-written on every
`put` purely so the store can answer queries — scope containment (`@>`),
status filter, terminal `prune` — without deserializing every payload. **No
ORM.** **The library never owns your schema:** every SQL concern is an escape
hatch on the factory.

## Quick start

```ts
import { Pool } from "pg";
import { withTasks } from "agentick";
import { postgresTaskStore } from "@agentick/tasks-store-postgres-next";

// BYO pool — the adapter never creates or closes it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Inject one app-scoped durable store; detached tasks survive session close
// and the whole app process, resumable on the next boot.
withTasks({ store: postgresTaskStore({ executor: pool }) });
// or: createApp(MyAgent, { model, tasks: { store: postgresTaskStore({ executor: pool }) } });
```

Apply the schema with your own migration tooling (the recommended path):

```ts
import { postgresTaskSchemaSql } from "@agentick/tasks-store-postgres-next";

await pool.query(postgresTaskSchemaSql());
// → CREATE TABLE IF NOT EXISTS "agentick_tasks" ( ... );
```

Or let the adapter create it once, lazily (opt-in, never forced):

```ts
postgresTaskStore({ executor: pool, migrate: "create-if-absent" });
```

## API

### `postgresTaskStore(options): TaskStore`

| Option     | Type                          | Default            | Description                                                                        |
| ---------- | ----------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `executor` | `pg.Pool \| QueryExecutor`    | **required**       | BYO connection. A `pg.Pool` or a minimal `{ query(text, values?) }`. Never owned.  |
| `table`    | `string`                      | `"agentick_tasks"` | Table name.                                                                        |
| `columns`  | `Partial<TaskColumns>`        | snake_case         | Map logical `taskId`/`scope`/`status`/`updatedAt`/`payload`/`schemaVer` onto real columns. |
| `sql`      | `TaskSqlOverrides`            | generated          | Per-operation FULL SQL override (see below).                                       |
| `codec`    | `TaskCodec`                   | identity           | `jsonb` payload encode/decode + schema-on-read (`encrypt`, `compress`, migrate).   |
| `migrate`  | `"off" \| "create-if-absent"` | `"off"`            | `"off"` never runs DDL; `"create-if-absent"` runs `CREATE TABLE IF NOT EXISTS` once. |

`backend` is `"postgres"`. Implements the full [`TaskStore`](../spec/src/protocol/tasks-store.ts)
port (`put` upsert, `get`, `list`, `delete`, `prune`). Per ADR 49's "NO
`define*` helper" amendment, the adapter `implements TaskStore` directly via a
factory — the `postgresTimelineStore` shape.

### `postgresTaskSchemaSql(table?, columns?): string`

The default DDL (table + GIN scope index + btree status index), exported for
manual application. Shipped for your migration tooling, not auto-run.

### Escape hatches

**Existing / partitioned / multi-tenant table** — map column names:

```ts
postgresTaskStore({
  executor: pool,
  table: "jobs",
  columns: { taskId: "job_id", payload: "body", status: "state" },
});
```

**Full per-operation SQL** — each override is a function that receives the
operation's inputs and returns `{ text, values }`. Project the configured
column names so the store can read results back (`get` / `list` must return
`<payload>` + `<schemaVer>`):

```ts
postgresTaskStore({
  executor: pool,
  sql: {
    // Multi-tenant: scope every read to the current tenant.
    get: ({ taskId }) => ({
      text: `SELECT payload, schema_ver FROM jobs
             WHERE tenant_id = current_setting('app.tenant')::int AND job_id = $1`,
      values: [taskId],
    }),
  },
});
```

**Encrypted / versioned payloads** — the codec owns the `jsonb` boundary:

```ts
postgresTaskStore({
  executor: pool,
  codec: {
    encode: (record) => encrypt(record),
    decode: (payload, schemaVer) => migrate(decrypt(payload), schemaVer),
  },
});
```

## Default schema

```sql
CREATE TABLE IF NOT EXISTS "agentick_tasks" (
  "task_id"    text PRIMARY KEY,
  "scope"      jsonb NOT NULL,
  "status"     text NOT NULL,
  "updated_at" bigint NOT NULL,
  "payload"    jsonb NOT NULL,
  "schema_ver" int NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agentick_tasks_scope_gin" ON "agentick_tasks" USING gin ("scope");
CREATE INDEX IF NOT EXISTS "agentick_tasks_status_idx" ON "agentick_tasks" ("status");
```

## Design notes

- **`payload` is the single source of truth.** Reads reconstruct the record
  from `payload` alone; `scope`/`status`/`updated_at` are write-only query
  keys. This keeps the record self-consistent even if a projection column and
  the payload ever disagree.
- **Upsert per transition.** `put` is `INSERT ... ON CONFLICT (task_id) DO
  UPDATE` — the harness `put`s a new record on every FSM transition; later
  `put`s of the same id replace in place.
- **Scope containment via GIN.** `list({ scope })` issues `scope @> $1::jsonb`
  (every provided dimension must match), indexed by the GIN index. `status`
  narrows via `status = ANY($n::text[])` (a single status is normalized to a
  one-element array).
- **Terminal-only `prune`.** `prune(before)` deletes `updated_at < before AND
  status = ANY('{completed,failed,cancelled,interrupted}')` — an in-flight
  `working` / `input_required` task is never pruned, matching
  `InMemoryTaskStore.prune`.
- **`bigint` is write-only here.** `updated_at` is a `bigint` column; pg
  returns `bigint` as a string, but this adapter only ever writes it (the
  record's `updatedAt` also rides inside `payload`, which is what reads use),
  so no read-side `Number` coercion is needed.
- **Minimal executor shape.** No operation depends on `rowCount`; a bare
  `{ query(text, values?): Promise<{ rows }> }` satisfies `QueryExecutor`.

## Verified by

- `src/__tests__/conformance.spec.ts` — runs `runTaskStoreConformance` against
  a **REAL Postgres** (real `jsonb`, real `@>` containment, real GIN/btree
  indexes). No fakes: no pg-mem, no in-memory stand-in (they don't honor
  `jsonb` containment faithfully). **Gated** on a `TASKS_PG_URL` connection
  string; absent, the suite registers **skipped** via the conformance suite's
  `skip` option (the `sandbox-docker` gate pattern) — the correct, honest
  outcome without a real backend. Each test gets a fresh uniquely-named table
  (`migrate: "create-if-absent"`); `afterAll` drops them. **Validated:** all
  10 conformance cases pass against Postgres 16 (`docker run postgres:16`).
- `src/__tests__/resume.spec.ts` — the cross-process resume PROOF (also
  `TASKS_PG_URL`-gated): (1) **interrupted-on-restart** — harness #1 submits a
  never-settling in-process task and is abandoned WITHOUT `close()`; harness #2
  over a fresh adapter on the SAME pool+table hydrates and marks the orphan
  `interrupted` (asserted in the projection AND in pg). (2) **terminal
  adoption** — harness #1 completes a task; harness #2 hydrates and
  `result(taskId)` returns the stored blocks decoded from pg. **Validated:**
  both cases pass against Postgres 16.

## Status & roadmap

- **Status:** complete for the ADR 68 v2.0 pg-tier contract. Passes the shared
  `TaskStore` conformance suite + the cross-process resume proof against real
  Postgres 16.

### Known gaps

- **Cross-restart CHILD reattach is out of scope for a fork-IPC executor —
  it's the distributed tier.** `interrupted`-on-restart is the *correct*
  outcome for both bundled executors: a lost in-process fiber can't reattach,
  and a `ChildProcessTaskExecutor` child can't either — fork IPC is a
  spawn-time pipe (`NODE_CHANNEL_FD`) that a freshly-restarted process cannot
  re-attach to, so re-finding the child by pid gives no channel to receive its
  transitions. Durable storage of the record is necessary but nowhere near
  sufficient. A worker whose reports must survive parent death has to report
  via a reconnectable transport (this durable store / the cluster bus) with the
  parent *observing* that plane — which is the **distributed-executor tier**
  (ADR 68 ambitious), not a follow-on to the child-process executor. This store
  persists `executorState` faithfully for whatever that tier needs; the
  fork-IPC executor self-terminates its worker on IPC `disconnect` rather than
  orphaning it.
- **`ttl` enforcement.** `ttl` is persisted on the record but nothing reaps a
  task whose `ttl` elapsed (shared ADR 68 gap, `TODO(ADR-68 ttl)` in the
  harness). A store-side reaper could ride on `prune`.
- **Entry wire-shape migration.** `schema_ver` is written (default 1) and
  passed to `codec.decode`, so schema-on-read migration is expressible today;
  a first-class migration-function registry is an additive follow-up.
