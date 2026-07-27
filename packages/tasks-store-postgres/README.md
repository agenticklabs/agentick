# @agentick/tasks-store-postgres

**A task that outlives the process that started it.** `postgresTaskStore` persists the task state machine to Postgres, which is what makes a background task resumable: the record is the truth, the running fiber is just how it happens to be executing right now. Kill the app mid-task and a fresh boot over the same table knows what was in flight, what finished, and what was orphaned.

The bundled in-memory store is `:memory:` — records die with the process, and every cross-restart behavior is a same-process no-op there. This adapter is where those behaviors become real.

## Install

```bash
npm install @agentick/tasks-store-postgres pg
```

## Quick start

One app-scoped store. Bring your own pool; the adapter never creates one and never closes one:

```ts
import { Pool } from "pg";
import { createApp } from "@agentick/app/react";
import { postgresTaskStore } from "@agentick/tasks-store-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = await createApp(MyAgent, {
  model,
  tasks: { store: postgresTaskStore({ executor: pool }) },
});
```

The store is app-scoped rather than per-session on purpose: a detached task survives the session that spawned it, so its record cannot live in session-shaped storage.

Apply the schema with your own migration tooling — the recommended path:

```ts
import { postgresTaskSchemaSql } from "@agentick/tasks-store-postgres";

await pool.query(postgresTaskSchemaSql());
```

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

Or let the adapter create it once, lazily. Opt-in, never forced:

```ts
postgresTaskStore({ executor: pool, migrate: "create-if-absent" });
```

## What durability actually buys

Three behaviors that only exist once records outlive the process:

**Orphan accounting that means something.** On construction, tasks hydrates its scope's records. A record still marked `working` whose in-process fiber died with the previous process gets marked `interrupted` — an honest terminal state, written back durably. With an in-memory store there is nothing to hydrate and nothing to orphan.

**Terminal adoption.** A task that completed in the old process is hydrated by the new one, and `result(taskId)` returns the stored blocks decoded from `jsonb` rather than from a live promise nobody holds any more.

**Detached tasks that survive session close.** The record is app-scoped and durable, so "keep working after the user disconnects" is storage, not a special execution mode.

> [!IMPORTANT]
> Cross-restart **reattach** is a different thing and is deliberately not offered. A lost in-process fiber cannot be resumed, and neither can a forked child — its IPC channel is a spawn-time pipe a restarted parent cannot re-open. `interrupted` is the correct outcome for both bundled executors. This store persists `executorState` faithfully for an executor that reports over a reconnectable transport, but durable storage is necessary, not sufficient.

## Project, don't translate

The `payload` column holds the **whole record**, encoded by the codec and otherwise untouched. Everything else is a **projection**: a column that exists only because a query needs it.

| Column       | Role                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| `payload`    | The record. The single source of truth; reads reconstruct from it alone          |
| `task_id`    | Primary key — the upsert target                                                  |
| `scope`      | Write-only query key. `list({ scope })` issues `scope @> $1::jsonb`, GIN-indexed |
| `status`     | Write-only query key. `status = ANY($n::text[])`, btree-indexed                  |
| `updated_at` | Write-only query key. Drives the terminal-only `prune`                           |

The projections are re-written on every `put` and **never read back into a record**. That keeps a record self-consistent even if a projection column and the payload ever disagree, and it means the record's shape can evolve without a schema migration.

The rule to copy in your own SQL adapter: add a projection column when a query needs one, never to normalize the record. Version drift is handled on read — every row carries `schema_ver`, and `codec.decode(payload, schemaVer)` is where a pure migration runs.

```ts
postgresTaskStore({
  executor: pool,
  codec: {
    encode: (record) => encrypt(record),
    decode: (payload, schemaVer) => migrateRecord(decrypt(payload), schemaVer),
  },
});
```

## The library never owns your schema

Already have a `jobs` table? Map the logical columns onto it:

```ts
postgresTaskStore({
  executor: pool,
  table: "jobs",
  columns: { taskId: "job_id", payload: "body", status: "state" },
});
```

When mapping isn't enough — a partitioned table, row-level tenancy, a computed column — replace the statement. Each `sql` override is a function of the operation's inputs returning `{ text, values }`:

```ts
postgresTaskStore({
  executor: pool,
  table: "jobs",
  columns: { taskId: "job_id", payload: "body", status: "state" },
  sql: {
    // Row-level tenancy: scope every read to the current tenant.
    get: ({ taskId }) => ({
      text: `SELECT body, schema_ver FROM jobs
             WHERE tenant_id = current_setting('app.tenant')::int AND job_id = $1`,
      values: [taskId],
    }),
  },
});
```

Each override has to project what the store reads back, aliased to your configured column names:

| Override | Receives                                                   | Must project                                |
| -------- | ---------------------------------------------------------- | ------------------------------------------- |
| `put`    | `{ taskId, scope, status, updatedAt, payload, schemaVer }` | nothing — the result is ignored             |
| `get`    | `{ taskId }`                                               | at most one row: `<payload>`, `<schemaVer>` |
| `list`   | `{ query }` — the `{ scope?, status? }` filter             | rows of `<payload>`, `<schemaVer>`          |
| `delete` | `{ taskId }`                                               | nothing                                     |
| `prune`  | `{ before }` — the ms-epoch cutoff                         | nothing                                     |

`put` receives the already-encoded payload, so an override can build any partitioned or encrypted UPSERT without re-running the codec. Omit an override and that operation uses generated SQL.

## Implementing your own

This adapter is a factory returning an object that implements `TaskStore` directly — no base class, no wrapper, and yours doesn't need one. The port is five verbs plus one optional:

| Verb                  | Required | Contract                                                                                                         |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `put(record, ctx)`    | yes      | **Upsert** — called on every FSM transition. A later `put` of the same `taskId` replaces                         |
| `get(taskId, ctx)`    | yes      | The record, or `undefined` for an id the store has never seen                                                    |
| `list(query, ctx)`    | yes      | Filter by `scope` (every provided dimension must match) and `status` (one or a set). No query returns everything |
| `delete(taskId, ctx)` | yes      | Remove one record. Idempotent — deleting an absent id settles normally                                           |
| `prune(before, ctx)`  | no       | GC **terminal** records with `updatedAt < before`. An in-flight task is never eligible                           |
| `query` / `mutate`    | derived  | The generic `Store` seam — `query` is `list`, `mutate` is the put/delete arms                                    |

Three rules the types cannot enforce:

- **The record round-trip is lossless.** Records are opaque blobs. Whatever `put` took, `get` and `list` return — including `result` and `executorState`, whose types are `unknown` precisely because a task's return value is generic.
- **`put` replaces, never merges.** Every transition writes a complete record. A store that patches fields will silently keep stale ones.
- **`prune` is terminal-only.** `completed`, `failed`, `cancelled`, `interrupted` are eligible; `working` and `input_required` are not, no matter how old. Reaping an in-flight task loses work.

### `StoreCtx`

Every data method takes a `StoreCtx` as its final parameter. Two lines of truth:

- An **in-memory** store accepts and ignores it — it holds no durable state that identity or idempotency would change.
- A **durable** store reads `ctx.opId` as the **idempotency key** to dedup a retried write, and `ctx.principal` (plus the `EventScope` coordinates) to scope reads and writes by tenant.

`ctx.signal` is an optional abort a long-running statement may honor. Every field is optional — outside an active operation scope they are `undefined`.

### Certify it

`jsonb` containment, upsert-in-place, and terminal-only pruning are not type-checkable. Run the suite against a **real** backend — this package refuses `pg-mem` and in-memory stand-ins, which don't honor `@>` containment faithfully, so a green there would be a lie:

```ts
import { Pool } from "pg";
import { runTaskStoreConformance } from "@agentick/tasks/testing";
import { postgresTaskStore } from "@agentick/tasks-store-postgres";

const url = process.env.TASKS_PG_URL;
const pool = url ? new Pool({ connectionString: url }) : undefined;
let n = 0;

runTaskStoreConformance({
  label: url ? "postgres" : "postgres (skipped: TASKS_PG_URL unset)",
  skip: pool === undefined,
  factory: () =>
    postgresTaskStore({
      executor: pool!,
      table: `agentick_tasks_test_${process.pid}_${++n}`,
      migrate: "create-if-absent",
    }),
});
```

The `skip` flag is what keeps a backend-gated suite honest: absent a connection string it registers as **skipped** rather than passing vacuously. A fresh uniquely-named table per store isolates each case; drop them in `afterAll`.

Then add what the shared suite cannot reach. For this adapter that is the cross-process proof: drive a harness against the store, abandon it without closing, build a second harness over a fresh adapter on the same table, and assert the orphan came back `interrupted` — in the projection and in the database.

## Operational notes

**Write volume.** `put` fires on every transition: submit, each progress fold, each status-message change, and the terminal write. A chatty task is a chatty writer. `ON CONFLICT (task_id) DO UPDATE` keeps it one round-trip and one row.

**Retention.** `prune(before)` deletes terminal records older than an ms-epoch cutoff. Nothing schedules it — call it from your own reaper.

**Indexes.** The GIN index on `scope` serves the containment filter; the btree on `status` serves the status filter and the prune predicate. Drop either and `list` degrades to a scan.

**`bigint` is write-only.** `updated_at` is a `bigint` column, which the driver returns as a string — but this adapter only ever writes it. The record's own `updatedAt` rides inside `payload`, which is what reads use, so there is no coercion on the read path.

## API

### `postgresTaskStore(options): TaskStore`

| Option     | Type                          | Default            | Description                                                                             |
| ---------- | ----------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `executor` | `pg.Pool \| QueryExecutor`    | **required**       | BYO connection. Never created, never closed by the adapter                              |
| `table`    | `string`                      | `"agentick_tasks"` | Table name                                                                              |
| `columns`  | `Partial<TaskColumns>`        | snake_case         | Map `taskId` / `scope` / `status` / `updatedAt` / `payload` / `schemaVer` / `createdAt` |
| `sql`      | `TaskSqlOverrides`            | generated          | Per-operation full SQL override                                                         |
| `codec`    | `TaskCodec`                   | identity           | `jsonb` encode/decode plus schema-on-read migration                                     |
| `migrate`  | `"off" \| "create-if-absent"` | `"off"`            | `"off"` never runs DDL; `"create-if-absent"` runs the DDL once, lazily                  |

`backend` is `"postgres"`. No operation depends on `rowCount`, so a bare `{ query(text, values?): Promise<{ rows }> }` satisfies `QueryExecutor`.

### Other exports

| Export                                                                     | Purpose                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `postgresTaskSchemaSql(table?, columns?)`                                  | The default DDL — table plus both indexes — for your tooling |
| `DEFAULT_TABLE` / `DEFAULT_COLUMNS`                                        | The defaults, for building a variant config                  |
| `SCHEMA_VERSION`                                                           | The version stamped on every row this adapter writes         |
| `TaskPutProjection` (type)                                                 | What a `put` override receives                               |
| `TaskCodec` / `TaskSqlOverrides` / `TaskColumns` / `QueryExecutor` (types) | The escape-hatch shapes                                      |

## Patterns

**Tasks.** [@agentick/tasks](../tasks) owns `InMemoryTaskStore`, the FSM, the executor seam, the `task_*` model-facing tools, and the conformance suite. This package is durability and nothing else.

**Timeline durability.** [@agentick/timeline-postgres](../timeline-postgres) is the sibling adapter with the same BYO-pool discipline and escape-hatch surface, over an append-only log rather than a mutable keyed table.

**Shapes.** [@agentick/spec](../spec) owns `TaskRecord`, `TaskStore`, `TaskStoreQuery`, `TaskStatus`, `EventScope`, and `StoreCtx`.

## Roadmap & known gaps

- **`StoreCtx` is accepted and ignored.** No write is deduped on `ctx.opId`, and no read is scoped by `ctx.principal` — tenancy today means a `sql` override or a separate table.
- **No cross-restart reattach.** By design, per the note above: a lost fiber or a forked child cannot be resumed, and `interrupted` is the honest outcome. A reattaching executor needs a reconnectable transport, not just this store.
- **`ttl` is persisted but not enforced.** A record carries its `ttl`; nothing reaps a task whose `ttl` elapsed. A store-side reaper could ride on `prune`.
- **Record-shape migration is manual.** `schema_ver` is written and handed to `codec.decode`, so schema-on-read is expressible — but there is no migration-function registry to declare one per version.
- **`list` ordering is by `updated_at`.** The port leaves order unspecified; this adapter picks a stable one. Don't depend on it, and don't expect a `limit` or cursor — neither is in the port.

## Verified by

- `src/__tests__/conformance.spec.ts` — the shared `runTaskStoreConformance` suite against a **real Postgres** (real `jsonb`, real `@>` containment, real GIN and btree indexes), gated on a `TASKS_PG_URL` connection string and registering as skipped without one: put/get round-trip, upsert-in-place, unfiltered `list`, scope containment, status filtering by single value and by set, the two filters combined, idempotent `delete`, terminal-only `prune`, and a stable non-empty `backend`. A fresh uniquely-named table per case; `afterAll` drops them. Validated against Postgres 16.
- `src/__tests__/resume.spec.ts` — the cross-process proof, on the same gate. A first harness submits a never-settling task and is abandoned without closing; a second harness over a fresh adapter on the same pool and table hydrates it, reports `interrupted` in the projection, persists `interrupted` to the database, and rejects `result()` with the interrupted status. Separately: a task that completed in the first harness is adopted by the second, whose `result()` returns the blocks decoded from `jsonb` rather than from a live fiber.
