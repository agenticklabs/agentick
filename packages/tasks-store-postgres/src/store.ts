/**
 * `postgresTaskStore` — Postgres {@link TaskStore} adapter (ADR 68 pg
 * tier, the flexible **cloud pole**). The durable backing that unlocks
 * cross-app-restart task resume: task records outlive the process, so a
 * fresh {@link import("@agentick/tasks").TasksHarness} over the same
 * table hydrates prior records and — for a `working` record whose
 * in-process fiber died with the old process — marks it `interrupted` for
 * real (a no-op with the in-memory store, which is same-process).
 *
 * Per ADR 49's "NO `define*` helper" amendment, this follows the
 * `postgresTimelineStore` / `CredentialsStore` precedent exactly — a
 * factory returning an object that `implements TaskStore` DIRECTLY. No
 * intermediate wrapper.
 *
 * ## Record vs. projections
 *
 * The `payload` jsonb column is the **single source of record truth** — the
 * full {@link TaskRecord}. `scope` (jsonb), `status` (text), and
 * `updated_at` (bigint) are **denormalized projections** re-written on
 * every `put` purely so the store can answer queries (`scope @>`, status
 * filter, terminal `prune`) without deserializing every payload. Reads
 * reconstruct the record from `payload` alone; the projection columns are
 * never read back into a record.
 *
 * ## Escape hatches — the library never owns your schema
 *
 * `executor` (BYO pool), `table`, `columns`, `sql` (per-op full override),
 * `codec` (jsonb + schema_ver), `migrate` — see {@link
 * PostgresTaskStoreOptions}. Mirrors `postgresTimelineStore` 1:1.
 *
 * `updated_at` is `bigint`; pg returns bigint as a string. This adapter
 * only ever writes it (the record's `updatedAt` also rides inside the
 * `payload` jsonb, which is what reads use), so no read-side `Number`
 * coercion is needed here.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

import type { Pool as PgPool } from "pg";

import type {
  CollectionMutation,
  EventScope,
  StoreCtx,
  TaskRecord,
  TaskStatus,
  TaskStore,
  TaskStoreQuery,
} from "@agentick/spec";

import {
  DEFAULT_COLUMNS,
  DEFAULT_TABLE,
  postgresTaskSchemaSql,
  quoteIdent,
  SCHEMA_VERSION,
  type TaskColumns,
} from "./schema.ts";

/** One executed SQL statement: text + positional bind values. */
export interface SqlQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
}

/** The subset of `pg.Pool` this adapter uses. A `pg.Pool` satisfies it
 *  structurally; adopters with a connection wrapper implement it directly. */
export interface QueryExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly rowCount?: number | null;
  }>;
}

/** The projected columns written on every `put` (the record's denormalized
 *  query keys + the authoritative encoded payload). Handed to a `put`
 *  override so it can build any partitioned / encrypted UPSERT. */
export interface TaskPutProjection {
  readonly taskId: string;
  readonly scope: EventScope;
  readonly status: TaskStatus;
  readonly updatedAt: number;
  /** `codec.encode(record)` — the value written to the `payload` jsonb column. */
  readonly payload: unknown;
  readonly schemaVer: number;
}

/**
 * Per-operation FULL SQL overrides. Each is a **function** the store calls
 * with the operation's inputs, returning the exact statement to run — the
 * honest "full control" seam for partitioned / encrypted / multi-tenant
 * schemas. Absent ops use the generated SQL.
 *
 * Contract for what each override MUST project (aliased to the configured
 * column names), so the store can read results back:
 *
 *   - `put` → no projection read (UPSERT; the store ignores the result);
 *   - `get` → at most one row with `<payload>` and `<schemaVer>`;
 *   - `list` → rows with `<payload>` and `<schemaVer>`;
 *   - `delete` → no projection read;
 *   - `prune` → no projection read.
 */
export interface TaskSqlOverrides {
  put?(input: TaskPutProjection): SqlQuery;
  get?(input: { taskId: string }): SqlQuery;
  list?(input: { query?: TaskStoreQuery }): SqlQuery;
  delete?(input: { taskId: string }): SqlQuery;
  prune?(input: { before: number }): SqlQuery;
}

/**
 * Payload codec — jsonb encode/decode with schema-on-read versioning.
 * Default is identity: the record object goes to the driver as a `jsonb`
 * param and comes back parsed. Adopters encrypt, compress, or migrate per
 * `schemaVer` here.
 */
export interface TaskCodec {
  /** record → the value written to the `payload` (jsonb) column. */
  encode(record: TaskRecord): unknown;
  /** stored payload + its `schema_ver` → record (run pure migrations here). */
  decode(payload: unknown, schemaVer: number): TaskRecord;
}

export interface PostgresTaskStoreOptions {
  /**
   * **BYO** connection: a `pg.Pool` or any `{ query(text, values?) }`
   * shape. The adapter NEVER creates or owns a pool and NEVER manages its
   * lifecycle — closing it is the adopter's job.
   */
  readonly executor: PgPool | QueryExecutor;
  /** Table name. Default `"agentick_tasks"`. */
  readonly table?: string;
  /** Logical → physical column names. Defaults to snake_case. */
  readonly columns?: Partial<TaskColumns>;
  /** Per-operation full SQL overrides. Absent ops use generated SQL. */
  readonly sql?: TaskSqlOverrides;
  /** jsonb payload codec. Default identity. */
  readonly codec?: TaskCodec;
  /**
   * `"off"` (default) — never run DDL; the adopter applies
   * {@link postgresTaskSchemaSql} via their own migration tooling.
   * `"create-if-absent"` — run `CREATE TABLE IF NOT EXISTS` once, lazily,
   * before the first operation.
   */
  readonly migrate?: "off" | "create-if-absent";
}

const IDENTITY_CODEC: TaskCodec = {
  encode: (record) => record,
  decode: (payload) => payload as TaskRecord,
};

/** Terminal FSM states — the only records `prune` is allowed to reap. */
const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

// TODO(store-phase-B): use ctx.opId for idempotency / ctx for scoping — every
// DATA method accepts the `StoreCtx` as its final arg but ignores it today; the
// durable dedup (write on ctx.opId) and event-sourced as-of read fold land in
// Run B.
class PostgresTaskStore implements TaskStore {
  readonly backend = "postgres" as const;

  private readonly exec: QueryExecutor;
  private readonly table: string;
  private readonly cols: TaskColumns;
  private readonly sql?: TaskSqlOverrides;
  private readonly codec: TaskCodec;
  private readonly migrate: "off" | "create-if-absent";

  /** Quoted identifiers, computed once. */
  private readonly q: { table: string } & Record<keyof TaskColumns, string>;

  /** Lazy one-shot migration guard. */
  private migrated?: Promise<void>;

  constructor(options: PostgresTaskStoreOptions) {
    this.exec = options.executor;
    this.table = options.table ?? DEFAULT_TABLE;
    this.cols = { ...DEFAULT_COLUMNS, ...options.columns };
    this.sql = options.sql;
    this.codec = options.codec ?? IDENTITY_CODEC;
    this.migrate = options.migrate ?? "off";
    this.q = {
      table: quoteIdent(this.table),
      taskId: quoteIdent(this.cols.taskId),
      scope: quoteIdent(this.cols.scope),
      status: quoteIdent(this.cols.status),
      updatedAt: quoteIdent(this.cols.updatedAt),
      payload: quoteIdent(this.cols.payload),
      schemaVer: quoteIdent(this.cols.schemaVer),
      createdAt: quoteIdent(this.cols.createdAt),
    };
  }

  /** Run `CREATE TABLE IF NOT EXISTS` at most once when opted in. */
  private ready(): Promise<void> {
    if (this.migrate === "off") return Promise.resolve();
    return (this.migrated ??= this.exec
      .query(postgresTaskSchemaSql(this.table, this.cols))
      .then(() => undefined));
  }

  private async run(query: SqlQuery): Promise<ReadonlyArray<Record<string, unknown>>> {
    await this.ready();
    const result = await this.exec.query(query.text, query.values);
    return result.rows;
  }

  private toRecord(row: Record<string, unknown>): TaskRecord {
    const schemaVer = Number(row[this.cols.schemaVer] ?? SCHEMA_VERSION);
    return this.codec.decode(row[this.cols.payload], schemaVer);
  }

  async put(record: TaskRecord, _ctx: StoreCtx): Promise<void> {
    const projection: TaskPutProjection = {
      taskId: record.taskId,
      scope: record.scope,
      status: record.status,
      updatedAt: record.updatedAt,
      payload: this.codec.encode(record),
      schemaVer: SCHEMA_VERSION,
    };
    const query = this.sql?.put?.(projection) ?? this.defaultPutSql(projection);
    await this.run(query);
  }

  private defaultPutSql(p: TaskPutProjection): SqlQuery {
    // scope/payload are objects → the pg driver serializes them to jsonb;
    // updated_at is a ms-epoch number written into a bigint column.
    return {
      text:
        `INSERT INTO ${this.q.table}` +
        ` (${this.q.taskId}, ${this.q.scope}, ${this.q.status}, ${this.q.updatedAt}, ${this.q.payload}, ${this.q.schemaVer})` +
        ` VALUES ($1, $2, $3, $4, $5, $6)` +
        ` ON CONFLICT (${this.q.taskId}) DO UPDATE SET` +
        ` ${this.q.scope} = EXCLUDED.${this.q.scope},` +
        ` ${this.q.status} = EXCLUDED.${this.q.status},` +
        ` ${this.q.updatedAt} = EXCLUDED.${this.q.updatedAt},` +
        ` ${this.q.payload} = EXCLUDED.${this.q.payload},` +
        ` ${this.q.schemaVer} = EXCLUDED.${this.q.schemaVer}`,
      values: [p.taskId, p.scope, p.status, p.updatedAt, p.payload, p.schemaVer],
    };
  }

  async get(taskId: string, _ctx: StoreCtx): Promise<TaskRecord | undefined> {
    const query =
      this.sql?.get?.({ taskId }) ??
      ({
        text: `SELECT ${this.q.payload}, ${this.q.schemaVer} FROM ${this.q.table} WHERE ${this.q.taskId} = $1`,
        values: [taskId],
      } satisfies SqlQuery);
    const rows = await this.run(query);
    return rows.length > 0 ? this.toRecord(rows[0]!) : undefined;
  }

  async list(query: TaskStoreQuery | undefined, _ctx: StoreCtx): Promise<readonly TaskRecord[]> {
    const sqlQuery = this.sql?.list?.({ query }) ?? this.defaultListSql(query);
    const rows = await this.run(sqlQuery);
    return rows.map((r) => this.toRecord(r));
  }

  private defaultListSql(query?: TaskStoreQuery): SqlQuery {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query?.scope !== undefined) {
      values.push(query.scope);
      clauses.push(`${this.q.scope} @> $${values.length}::jsonb`);
    }
    if (query?.status !== undefined) {
      // Normalize a single status to a one-element array → `= ANY(...)`.
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      values.push(statuses);
      clauses.push(`${this.q.status} = ANY($${values.length}::text[])`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return {
      // Order is unspecified by the port; a stable ordering keeps output
      // deterministic across runs.
      text: `SELECT ${this.q.payload}, ${this.q.schemaVer} FROM ${this.q.table}${where} ORDER BY ${this.q.updatedAt}`,
      values,
    };
  }

  async delete(taskId: string, _ctx: StoreCtx): Promise<void> {
    const query =
      this.sql?.delete?.({ taskId }) ??
      ({
        text: `DELETE FROM ${this.q.table} WHERE ${this.q.taskId} = $1`,
        values: [taskId],
      } satisfies SqlQuery);
    await this.run(query);
  }

  /**
   * GC terminal records last updated before `before` (ms-epoch). Mirrors
   * {@link import("@agentick/tasks").InMemoryTaskStore.prune}: only
   * terminal records are eligible — an in-flight `working` /
   * `input_required` task is never pruned no matter how old.
   */
  async prune(before: number, _ctx: StoreCtx): Promise<void> {
    const query =
      this.sql?.prune?.({ before }) ??
      ({
        text: `DELETE FROM ${this.q.table} WHERE ${this.q.updatedAt} < $1 AND ${this.q.status} = ANY($2::text[])`,
        values: [before, TERMINAL_STATUSES],
      } satisfies SqlQuery);
    await this.run(query);
  }

  // ── Store seam — required now `CollectionStore extends Store`. `query` is the
  // SQL WHERE projection ({@link list}); `mutate` is the UPSERT / DELETE arms.
  query(query: TaskStoreQuery | undefined, ctx: StoreCtx): Promise<readonly TaskRecord[]> {
    return this.list(query, ctx);
  }

  mutate(m: CollectionMutation<TaskRecord>, ctx: StoreCtx): Promise<void> {
    return "put" in m ? this.put(m.put, ctx) : this.delete(m.delete, ctx);
  }
}

/**
 * Construct a Postgres-backed {@link TaskStore}. BYO `pg.Pool` via
 * `executor`; the adapter never owns the pool's lifecycle.
 */
export function postgresTaskStore(options: PostgresTaskStoreOptions): TaskStore {
  return new PostgresTaskStore(options);
}
