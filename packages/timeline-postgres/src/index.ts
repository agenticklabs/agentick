/**
 * `@agentick/timeline-postgres` — Postgres {@link TimelineStore}
 * adapter (ADR 49 reference-adapter rung 4, the cloud pole).
 *
 * The shared source of truth across stateless replicas: any node
 * rehydrates a session with `read(sessionId)`. BYO `pg.Pool`; DB-assigned
 * `bigint IDENTITY` `seq`; opaque `jsonb` payloads; schema escape hatches.
 *
 * ```ts
 * import { Pool } from "pg";
 * import { createApp } from "agentick";
 * import { postgresTimelineStore } from "@agentick/timeline-postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * createApp(Agent, {
 *   model,
 *   timeline: { store: postgresTimelineStore({ executor: pool }) },
 * });
 * ```
 *
 * Per ADR 49's "NO `define*` helper" amendment, the adapter implements
 * `TimelineStore` directly via a factory — the `CredentialsStore` shape.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

export {
  postgresTimelineStore,
  type PostgresTimelineStoreOptions,
  type QueryExecutor,
  type SqlQuery,
  type TimelineCodec,
  type TimelineSqlOverrides,
} from "./store.js";

export {
  DEFAULT_COLUMNS,
  DEFAULT_TABLE,
  postgresTimelineSchemaSql,
  SCHEMA_VERSION,
  type TimelineColumns,
} from "./schema.js";
