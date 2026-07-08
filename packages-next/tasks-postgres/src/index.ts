/**
 * `@agentick/tasks-postgres-next` — Postgres {@link TaskStore} adapter
 * (ADR 68 pg tier, the flexible cloud pole).
 *
 * The durable backing that unlocks cross-app-restart task resume: task
 * records outlive the process, so a fresh `TasksHarness` over the same
 * table hydrates prior records and marks an orphaned `working` record
 * `interrupted` for real. BYO `pg.Pool`; opaque `jsonb` payloads (the
 * authoritative record) with denormalized scope/status/updated_at query
 * columns; schema escape hatches.
 *
 * ```ts
 * import { Pool } from "pg";
 * import { withTasks } from "agentick";
 * import { postgresTaskStore } from "@agentick/tasks-postgres-next";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * withTasks({ store: postgresTaskStore({ executor: pool }) });
 * // or: createApp(App, { tasks: { store: postgresTaskStore({ executor: pool }) } })
 * ```
 *
 * Per ADR 49's "NO `define*` helper" amendment, the adapter implements
 * `TaskStore` directly via a factory — the `postgresTimelineStore` shape.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

export {
  postgresTaskStore,
  type PostgresTaskStoreOptions,
  type QueryExecutor,
  type SqlQuery,
  type TaskCodec,
  type TaskPutProjection,
  type TaskSqlOverrides,
} from "./store.js";

export {
  DEFAULT_COLUMNS,
  DEFAULT_TABLE,
  postgresTaskSchemaSql,
  SCHEMA_VERSION,
  type TaskColumns,
} from "./schema.js";
