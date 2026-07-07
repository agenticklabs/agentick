# @agentick/timeline-postgres-next

**Postgres** `TimelineStore` adapter — the cloud-pole durable shape from
[ADR 49, "stores, not snapshots"](../../docs/proposals/v2/blueprint/49-stores-not-snapshots.md)
(reference-adapter rung 4).

The **shared source of truth across stateless replicas**: any node
rehydrates a session with `load(sessionId)`, so node death = the next
`send` rehydrates on whichever node receives it. SQLite-on-local-disk
cannot fill this role (single writer, local file); Postgres is the
cloud-pole default.

## Purpose

Persist the timeline's append-only event log to Postgres with a **frozen,
tiny schema** — `(session_id, seq, payload)` — opaque `jsonb` payloads, and
schema-on-read versioning. `seq` is a `bigint GENERATED ALWAYS AS IDENTITY`
column, which satisfies the port's store-assigned / strictly-increasing /
never-reused / prune-stable `seq` contract out of the box. **No ORM** — the
surface is a handful of statements. **The library never owns your schema**:
every SQL concern is an escape hatch on the factory.

## Quick start

```ts
import { Pool } from "pg";
import { createApp } from "agentick";
import { postgresTimelineStore } from "@agentick/timeline-postgres-next";

// BYO pool — the adapter never creates or closes it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Inject the store on the session's timeline slot: any node rehydrates a
// session with `load(sessionId)`, so session construction is open-or-rehydrate.
const store = postgresTimelineStore({ executor: pool });
const app = await createApp(MyAgent, { model, session: { timeline: { store } } });
```

Apply the schema with your own migration tooling (the recommended path):

```ts
import { postgresTimelineSchemaSql } from "@agentick/timeline-postgres-next";

await pool.query(postgresTimelineSchemaSql());
// → CREATE TABLE IF NOT EXISTS "agentick_timeline" ( ... );
```

Or let the adapter create it once, lazily (opt-in, never forced):

```ts
postgresTimelineStore({ executor: pool, migrate: "create-if-absent" });
```

## API

### `postgresTimelineStore(options): TimelineStore`

| Option     | Type                              | Default              | Description                                                                 |
| ---------- | --------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| `executor` | `pg.Pool \| QueryExecutor`        | **required**         | BYO connection. A `pg.Pool` or a minimal `{ query(text, values?) }`. Never owned. |
| `table`    | `string`                          | `"agentick_timeline"`| Table name.                                                                 |
| `columns`  | `Partial<TimelineColumns>`        | snake_case           | Map logical `sessionId`/`seq`/`payload`/`schemaVer` onto real columns.      |
| `sql`      | `TimelineSqlOverrides`            | generated            | Per-operation FULL SQL override (see below).                                |
| `codec`    | `TimelineCodec`                   | identity             | `jsonb` payload encode/decode + schema-on-read (`encrypt`, `compress`, migrate). |
| `migrate`  | `"off" \| "create-if-absent"`     | `"off"`              | `"off"` never runs DDL; `"create-if-absent"` runs `CREATE TABLE IF NOT EXISTS` once. |

`backend` is `"postgres"`. Implements the full [`TimelineStore`](../timeline/src/store.ts)
port. Per ADR 49's "NO `define*` helper" amendment, the adapter
`implements TimelineStore` directly via a factory — the `CredentialsStore`
shape.

### `postgresTimelineSchemaSql(table?, columns?): string`

The default DDL, exported for manual application. Shipped for your migration
tooling, not auto-run.

### Escape hatches

**Existing / partitioned / multi-tenant table** — map column names:

```ts
postgresTimelineStore({
  executor: pool,
  table: "chat_events",
  columns: { sessionId: "conversation_id", payload: "body", seq: "event_no" },
});
```

**Full per-operation SQL** — each override is a function that receives the
operation's inputs and returns `{ text, values }`, so it can express
`append`'s variable row count (a static string cannot). Project the
configured column names so the store can read results back:

```ts
postgresTimelineStore({
  executor: pool,
  sql: {
    // Multi-tenant: scope every read/write to the current tenant.
    load: ({ sessionId }) => ({
      text: `SELECT payload, schema_ver FROM chat_events
             WHERE tenant_id = current_setting('app.tenant')::int
               AND conversation_id = $1 ORDER BY event_no`,
      values: [sessionId],
    }),
  },
});
```

**Encrypted / versioned payloads** — the codec owns the `jsonb` boundary:

```ts
postgresTimelineStore({
  executor: pool,
  codec: {
    encode: (entry) => encrypt(entry),
    decode: (payload, schemaVer) => migrate(decrypt(payload), schemaVer),
  },
});
```

## Default schema

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

## Design notes

- **`seq` via IDENTITY.** DB-assigned, strictly increasing, never reused,
  never reset by `DELETE`. The global IDENTITY trivially satisfies the
  per-session strictly-increasing contract (start value + contiguity are
  implementation-defined). Note vs. `MemoryTimelineStore`: after `delete`,
  Memory restarts a session's `seq` at 0; Postgres continues the global
  IDENTITY. Both are conformant — the suite asserts
  strictly-increasing/never-reused, not a particular start value.
- **One round-trip per flush.** `append` emits ONE multi-row
  `INSERT ... VALUES (...),(...) RETURNING seq`; the write-behind pump hands
  it a batch. Reads are cold (hydration once per open) over the PK index
  `(session_id, seq)`.
- **`bigint` → `number`.** The driver returns `bigint` as a string; the
  adapter coerces with `Number`. The port types `seq` as `number`, so its
  2^53 ceiling is the port's, not this adapter's.
- **Minimal executor shape.** `delete`/`prune` use `RETURNING` to count, so
  they work with a bare `{ query(text, values?): Promise<{ rows }> }` — not
  just a `pg.Pool`.

## Verified by

- `src/__tests__/conformance.spec.ts` — runs `runTimelineStoreConformance`
  against a **REAL Postgres** (real IDENTITY, real `jsonb`). No fakes: no
  pg-mem, no in-memory stand-in (they don't honor IDENTITY / jsonb
  faithfully). **Gated** on a `TIMELINE_PG_URL` connection string; absent,
  the suite registers **skipped** via the conformance suite's `skip` option
  (the `sandbox-docker` gate pattern) — the correct, honest outcome without
  a real backend. Each test gets a fresh uniquely-named table
  (`migrate: "create-if-absent"`); `afterAll` drops them. **Validated:** all
  14 cases pass against Postgres 16 (`docker run postgres:16-alpine`).

## Status & roadmap

- **Status:** complete for the ADR 49 v2.0 contract. Passes the shared
  conformance suite against real Postgres 16.

### Known gaps

- **Full-table `load`.** No paged/lazy tail yet (ADR 49 open question 1);
  `history({ fromSeq, limit })` covers cursored reads over the PK index.
- **Entry wire-shape migration (E11).** `schema_ver` is written (default 1)
  and passed to `codec.decode`, so schema-on-read migration is expressible
  today; a first-class migration-function registry is an additive follow-up
  when the first breaking entry-shape change appears (ADR 49 open question 2).
