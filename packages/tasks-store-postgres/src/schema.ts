/**
 * Column mapping + default DDL for the Postgres {@link TaskStore} adapter
 * (ADR 68 pg tier). Unlike the append-only timeline log, a task table is a
 * mutable, upsert-in-place CRUD store keyed by `task_id`: the `payload`
 * jsonb column is the authoritative full {@link TaskRecord}; `scope`,
 * `status`, and `updated_at` are **denormalized projections** written on
 * every `put` so the store can answer scope-containment / status / prune
 * queries without deserializing every payload.
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

/** Logical → physical column names. Adopters map onto an existing table. */
export interface TaskColumns {
  /** Primary key — the `taskId`. Default `"task_id"`. */
  readonly taskId: string;
  /** Owner coordinates (`jsonb`, GIN-indexed for containment). Default `"scope"`. */
  readonly scope: string;
  /** FSM state (`text`, indexed for the status filter). Default `"status"`. */
  readonly status: string;
  /** Last-transition ms-epoch (`bigint`, for `prune`). Default `"updated_at"`. */
  readonly updatedAt: string;
  /** The authoritative full {@link TaskRecord} (`jsonb`). Default `"payload"`. */
  readonly payload: string;
  /** Schema-on-read version tag. Default `"schema_ver"`. */
  readonly schemaVer: string;
  /** Created at timestamp (`timestamptz`). Default `"created_at"`. */
  readonly createdAt: string;
}

export const DEFAULT_TABLE = "agentick_tasks";

export const DEFAULT_COLUMNS: TaskColumns = {
  taskId: "task_id",
  scope: "scope",
  status: "status",
  updatedAt: "updated_at",
  payload: "payload",
  schemaVer: "schema_ver",
  createdAt: "created_at",
};

/** The schema version stamped on every row written by this adapter. */
export const SCHEMA_VERSION = 1;

/** Quote a SQL identifier — double-quote and escape embedded quotes. Config
 *  values are trusted (constructor-time, not user input); quoting supports
 *  mixed-case / reserved-word column names and is defence in depth. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Default DDL for manual application or `migrate: "create-if-absent"`.
 * Exported so adopters can apply it via their own migration tooling
 * (Flyway, node-pg-migrate, a checked-in `.sql`), which ADR 68/49 prefers
 * over auto-running DDL at boot.
 *
 * `task_id` is the PK (upsert target). `scope` gets a GIN index for the
 * `@>` containment queries `list` issues; `status` gets a btree index for
 * the status filter. `updated_at` drives the terminal-only `prune`.
 *
 * Index names are derived from the (trusted, config-time) table name so a
 * custom table doesn't collide with the default — kept simple: the raw
 * table string suffixed, then quoted as one identifier.
 */
export function postgresTaskSchemaSql(
  table: string = DEFAULT_TABLE,
  columns: TaskColumns = DEFAULT_COLUMNS,
): string {
  const t = quoteIdent(table);
  const c = {
    taskId: quoteIdent(columns.taskId),
    scope: quoteIdent(columns.scope),
    status: quoteIdent(columns.status),
    updatedAt: quoteIdent(columns.updatedAt),
    payload: quoteIdent(columns.payload),
    schemaVer: quoteIdent(columns.schemaVer),
    createdAt: quoteIdent(columns.createdAt),
  };
  const scopeIdx = quoteIdent(`${table}_scope_gin`);
  const statusIdx = quoteIdent(`${table}_status_idx`);
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (`,
    `  ${c.taskId} text PRIMARY KEY,`,
    `  ${c.scope} jsonb NOT NULL,`,
    `  ${c.status} text NOT NULL,`,
    `  ${c.updatedAt} bigint NOT NULL,`,
    `  ${c.payload} jsonb NOT NULL,`,
    `  ${c.schemaVer} int NOT NULL DEFAULT ${SCHEMA_VERSION},`,
    `  ${c.createdAt} timestamptz NOT NULL DEFAULT now()`,
    `);`,
    `CREATE INDEX IF NOT EXISTS ${scopeIdx} ON ${t} USING gin (${c.scope});`,
    `CREATE INDEX IF NOT EXISTS ${statusIdx} ON ${t} (${c.status});`,
  ].join("\n");
}
