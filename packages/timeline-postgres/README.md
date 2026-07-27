# @agentick/timeline-postgres

**The conversation, in a table your replicas share.** `postgresTimelineStore` persists the timeline's append-only log to Postgres, so any node can rehydrate any session: a process dies, the next message lands on a different replica, and `createSession({ sessionId })` reads the log back. A file on local disk cannot do that — single writer, single machine.

Five columns, no ORM, no migrations at boot. The schema is deliberately tiny and frozen: `(session_id, seq, payload)` plus a version tag and a timestamp, with entries stored as opaque `jsonb`.

## Install

```bash
npm install @agentick/timeline-postgres pg
```

## Quick start

Bring your own pool. The adapter never creates one and never closes one:

```ts
import { Pool } from "pg";
import { createApp } from "@agentick/app/react";
import { defineTimeline } from "@agentick/timeline";
import { postgresTimelineStore } from "@agentick/timeline-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = await createApp(MyAgent, {
  model,
  timeline: defineTimeline({ store: postgresTimelineStore({ executor: pool }) }),
});
```

Apply the schema with your own migration tooling — the recommended path:

```ts
import { postgresTimelineSchemaSql } from "@agentick/timeline-postgres";

await pool.query(postgresTimelineSchemaSql());
```

```sql
CREATE TABLE IF NOT EXISTS "agentick_timeline" (
  "session_id" text NOT NULL,
  "seq"        bigint GENERATED ALWAYS AS IDENTITY,
  "payload"    jsonb NOT NULL,
  "schema_ver" int NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("session_id", "seq")
);
```

Or let the adapter create it once, lazily. Opt-in, never forced:

```ts
postgresTimelineStore({ executor: pool, migrate: "create-if-absent" });
```

> [!NOTE]
> `executor` accepts a `pg.Pool` or anything with a `query(text, values?)` returning `{ rows }`. Every operation, including `delete` and `prune`, counts through `RETURNING` rather than `rowCount` — so a thin connection wrapper satisfies the whole port.

## `seq` for free — the IDENTITY column

The port freezes three properties on `seq`: **strictly increasing** within a session, **never reused**, **stable across `prune`**. `bigint GENERATED ALWAYS AS IDENTITY` satisfies all three with no bookkeeping on this side of the wire. It is DB-assigned, it never hands back a retired value, and `DELETE` does not reset the generator, so a pruned session's next append continues past the erased high-water mark.

The port leaves the start value and contiguity implementation-defined, which is what makes a global sequence conformant: a session's rows carry an increasing `seq` **subsequence**, not `0, 1, 2, …`. So the two shipped adapters legitimately differ after a `delete` — the in-memory store restarts that session at `0`, Postgres continues the global IDENTITY — and both pass the same suite. Never write code that assumes a specific first `seq`.

`seq` crosses as a `bigint`, which the driver returns as a string; the adapter coerces with `Number`. The port types `seq` as a `number`, so the 2^53-entry ceiling is the port's, not this adapter's.

## Project, don't translate

The `payload` column holds the whole entry, encoded by the codec and otherwise untouched — that is the **record**. Everything else in the table is a **projection**: a column that exists only because a query needs it.

For a log, the queries are "read this session in order" and "read this session from a cursor", so the projections are exactly `session_id` and `seq`, both in the primary key. Reads reconstruct the entry from `payload` alone; nothing else is ever read back into an entry.

That split is the pattern to copy in your own SQL adapter, and it is why entry shapes can evolve without a migration. Add a projection column when a query needs one — never to "normalize" the record.

Schema-on-read handles version drift: every row carries `schema_ver`, and `codec.decode(payload, schemaVer)` is where a pure migration function runs.

```ts
postgresTimelineStore({
  executor: pool,
  codec: {
    encode: (entry) => encrypt(entry),
    decode: (payload, schemaVer) => migrateEntry(decrypt(payload), schemaVer),
  },
});
```

## The library never owns your schema

Already have a `chat_events` table? Map the logical columns onto it:

```ts
postgresTimelineStore({
  executor: pool,
  table: "chat_events",
  columns: { sessionId: "conversation_id", payload: "body", seq: "event_no" },
});
```

When mapping isn't enough — a partitioned table, row-level tenancy, a generated column — replace the statement. Each `sql` override is a **function** of the operation's inputs returning `{ text, values }`, because `append`'s row count is variable and a static string cannot express it:

```ts
postgresTimelineStore({
  executor: pool,
  table: "chat_events",
  columns: { sessionId: "conversation_id", payload: "body", seq: "event_no" },
  sql: {
    // Row-level tenancy: scope the hydration read to the current tenant.
    read: ({ sessionId }) => ({
      text: `SELECT body, schema_ver FROM chat_events
             WHERE tenant_id = current_setting('app.tenant')::int
               AND conversation_id = $1
             ORDER BY event_no`,
      values: [sessionId],
    }),
  },
});
```

Each override has to project what the store reads back, aliased to your configured column names:

| Override | Must project                                   |
| -------- | ---------------------------------------------- |
| `append` | `RETURNING <seq>` — one row per inserted entry |
| `read`   | `<payload>`, `<schemaVer>`, in `seq` order     |
| `keys`   | `<sessionId>`                                  |
| `delete` | `RETURNING <seq>` — the store counts the rows  |
| `prune`  | `RETURNING <seq>` — the store counts the rows  |

Omit an override and that operation uses generated SQL. There is no `history` override; the cursored read is always generated (see gaps).

## Implementing your own

This adapter is a factory that returns an object implementing `TimelineStore` directly — no base class, no `defineFsStore`-style wrapper. Yours doesn't need one either. For a store that is a few statements against an existing table, `defineTimelineStore` skips the class entirely:

```ts
import { defineTimelineStore } from "@agentick/timeline";

const store = defineTimelineStore({
  backend: "my-log",
  append: (logKey, entries) => insertReturningSeq(logKey, entries),
  read: (logKey) => selectEntries(logKey),
  keys: () => selectDistinctKeys(),
  delete: (logKey) => deleteLog(logKey),
  history: (logKey, o) => selectEntriesFrom(logKey, o?.fromSeq, o?.limit),
});
```

### The verbs

| Verb                            | Required | Contract                                                                                        |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `append(logKey, entries, ctx)`  | yes      | The **only write**. Returns one `seq` per entry, in input order. `[]` in, `[]` out              |
| `read(logKey, ctx)`             | yes      | Full ordered read — the hydration fold input. `[]` for an unseen key. A defensive copy          |
| `keys(ctx)`                     | yes      | Every key holding entries. Order unspecified; a pruned-empty key is not listed                  |
| `delete(logKey, ctx)`           | yes      | Ends the log. Idempotent; `true` when entries were removed. A later append starts a fresh `seq` |
| `history(logKey, options, ctx)` | no       | Seq-tagged window: `seq >= fromSeq`, at most `limit`. Powers paging, replay, and scroll-back    |
| `prune(logKey, before, ctx)`    | no       | Retention / erasure: drop entries with absolute `seq < before.seq`. Never called by compaction  |
| `query` / `mutate`              | derived  | The generic `Store` seam — a log window and the append arm. Delegate to `history` and `append`  |

Three rules the types cannot enforce:

- **The entry round-trip is lossless.** Entries are opaque — whatever `append` took, `read` returns, in order, structurally identical. `seq` is store-assigned and never a field on the entry.
- **`read` returns a copy.** Mutating the returned array must never reach into the store. `jsonb` parsed fresh per row gets that for free.
- **The log is append-only.** There is no `replace`, and compaction never calls the store — it rewrites the model-facing projection only. `prune` is the single destructive verb.

### `StoreCtx`

Every data method takes a `StoreCtx` as its final parameter. Two lines of truth:

- An **in-memory** store accepts and ignores it — it holds no durable state that identity or idempotency would change.
- A **durable** store reads `ctx.opId` as the **idempotency key** to dedup a retried write, and `ctx.principal` (plus the `EventScope` coordinates) to scope reads and writes by tenant.

`ctx.signal` is an optional abort a long-running statement may honor. Every field is optional — outside an active operation scope they are `undefined`.

### Certify it

`seq` monotonicity, never-reuse, and prune-stability are not type-checkable, and neither is `jsonb` fidelity. Run the suite against a **real** backend — this package refuses `pg-mem` and in-memory Postgres stand-ins, which don't honor IDENTITY or `jsonb` faithfully, so a green there would be a lie:

```ts
import { Pool } from "pg";
import { runTimelineStoreConformance } from "@agentick/timeline/testing";
import { postgresTimelineStore } from "@agentick/timeline-postgres";

const url = process.env.TIMELINE_PG_URL;
const pool = url ? new Pool({ connectionString: url }) : undefined;
let n = 0;

runTimelineStoreConformance({
  label: url ? "postgres" : "postgres (skipped: TIMELINE_PG_URL unset)",
  skip: pool === undefined,
  factory: () =>
    postgresTimelineStore({
      executor: pool!,
      table: `agentick_timeline_test_${process.pid}_${++n}`,
      migrate: "create-if-absent",
    }),
});
```

The `skip` flag is what keeps a backend-gated suite honest: absent a connection string it registers as **skipped** rather than passing vacuously. A fresh uniquely-named table per store gives each case isolation; drop them in `afterAll`.

## Performance notes

**One round-trip per flush.** The timeline's write-behind pump hands `append` a batch, and the adapter emits one multi-row `INSERT ... VALUES (…),(…) RETURNING seq`. Not one statement per entry.

**Reads are cold.** Hydration is one `SELECT` per session open, over the `(session_id, seq)` primary key. `history({ fromSeq, limit })` is a bounded range scan on the same index.

**The default codec is nearly free.** The driver serializes the entry to `jsonb` and parses it back; nothing walks the entry in JavaScript.

## API

### `postgresTimelineStore(options): TimelineStore`

| Option     | Type                          | Default               | Description                                                                         |
| ---------- | ----------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `executor` | `pg.Pool \| QueryExecutor`    | **required**          | BYO connection. Never created, never closed by the adapter                          |
| `table`    | `string`                      | `"agentick_timeline"` | Table name                                                                          |
| `columns`  | `Partial<TimelineColumns>`    | snake_case            | Map `sessionId` / `seq` / `payload` / `schemaVer` / `createdAt` onto real columns   |
| `sql`      | `TimelineSqlOverrides`        | generated             | Per-operation full SQL override                                                     |
| `codec`    | `TimelineCodec`               | identity              | `jsonb` encode/decode plus schema-on-read migration                                 |
| `migrate`  | `"off" \| "create-if-absent"` | `"off"`               | `"off"` never runs DDL; `"create-if-absent"` runs `CREATE TABLE IF NOT EXISTS` once |

`backend` is `"postgres"`.

### Other exports

| Export                                                               | Purpose                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| `postgresTimelineSchemaSql(table?, columns?)`                        | The default DDL as a string, for your migration tooling |
| `DEFAULT_TABLE` / `DEFAULT_COLUMNS`                                  | The defaults, for building a variant config             |
| `SCHEMA_VERSION`                                                     | The version stamped on every row this adapter writes    |
| `QueryExecutor` (type)                                               | The minimal `{ query(text, values?) }` shape            |
| `TimelineCodec` / `TimelineSqlOverrides` / `TimelineColumns` (types) | The escape-hatch shapes                                 |

## Patterns

**Timeline.** [@agentick/timeline](../timeline) owns `TimelineStore`, `defineTimelineStore`, the write-behind pump and its flush barrier, compaction, and the conformance suite. This package is durability and nothing else.

**The local pole.** [@agentick/timeline-fs](../timeline-fs) is the same port over one JSONL file per session — greppable, zero-dependency, single-writer.

**Task durability.** [@agentick/tasks-store-postgres](../tasks-store-postgres) is the sibling adapter for the task FSM: the same BYO-pool discipline and escape-hatch surface, over a mutable keyed table rather than an append-only log.

**Shapes.** [@agentick/spec](../spec) owns `TimelineEntry`, `TimelineStore`, `LogQuery` / `LogMutation`, `SeqTagged`, and `StoreCtx`.

## Roadmap & known gaps

- **`StoreCtx` is accepted and ignored.** No write is deduped on `ctx.opId`, and no read is scoped by `ctx.principal` — tenancy today means a `sql` override or a separate table.
- **No `history` override.** The `sql` bag covers `append` / `read` / `keys` / `delete` / `prune`; the cursored read is always generated SQL, so a partitioned or tenant-scoped `history` needs a custom `QueryExecutor` that rewrites the statement.
- **Full-table hydration.** `read` loads a session's whole log; there is no paged or lazy tail on the hydration path. `history({ fromSeq, limit })` covers cursored reads once a session is open.
- **Entry-shape migration is manual.** `schema_ver` is written and handed to `codec.decode`, so schema-on-read is expressible — but there is no migration-function registry to declare one per version.
- **No transaction handle.** Every operation is one autocommit statement against the executor; you cannot enlist an append in a surrounding transaction.

## Verified by

- `src/__tests__/conformance.spec.ts` — the shared `runTimelineStoreConformance` suite against a **real Postgres** (real IDENTITY, real `jsonb`), gated on a `TIMELINE_PG_URL` connection string and registering as skipped without one: append ordering, one strictly-increasing `seq` per entry, empty-append no-op, `history` paging by `fromSeq` / `limit` with prune-stable tags, per-session isolation, defensive-copy `read`, enumeration, idempotent `delete`, and a stable non-empty `backend`. Each case gets a fresh uniquely-named table via `migrate: "create-if-absent"`; `afterAll` drops them. Validated against Postgres 16.
