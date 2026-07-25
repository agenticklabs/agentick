/**
 * Column mapping + default DDL for the Postgres {@link TimelineStore}
 * adapter (ADR 49). The schema is deliberately tiny and frozen: an
 * append-only `(session_id, seq, payload)` log with opaque `jsonb`
 * payloads and schema-on-read versioning — never migrated (E11).
 */

/** Logical → physical column names. Adopters map onto an existing table. */
export interface TimelineColumns {
  /** Session key column. Default `"session_id"`. */
  readonly sessionId: string;
  /** Store-assigned ordering identity (`bigint GENERATED ... AS IDENTITY`). Default `"seq"`. */
  readonly seq: string;
  /** Opaque `jsonb` entry payload. Default `"payload"`. */
  readonly payload: string;
  /** Schema-on-read version tag. Default `"schema_ver"`. */
  readonly schemaVer: string;
  /** Created at timestamp (`timestamptz`). Default `"created_at"`. */
  readonly createdAt: string;
}

export const DEFAULT_TABLE = "agentick_timeline";

export const DEFAULT_COLUMNS: TimelineColumns = {
  sessionId: "session_id",
  seq: "seq",
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
 * (Flyway, node-pg-migrate, a checked-in `.sql`), which ADR 49 prefers
 * over auto-running DDL at boot.
 *
 * `seq` is `bigint GENERATED ALWAYS AS IDENTITY` — DB-assigned, strictly
 * increasing, never reused; the global IDENTITY trivially satisfies the
 * per-session strictly-increasing `seq` contract (start value + contiguity
 * are implementation-defined per the port docs).
 */
export function postgresTimelineSchemaSql(
  table: string = DEFAULT_TABLE,
  columns: TimelineColumns = DEFAULT_COLUMNS,
): string {
  const t = quoteIdent(table);
  const c = {
    sessionId: quoteIdent(columns.sessionId),
    seq: quoteIdent(columns.seq),
    payload: quoteIdent(columns.payload),
    schemaVer: quoteIdent(columns.schemaVer),
    createdAt: quoteIdent(columns.createdAt),
  };
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (`,
    `  ${c.sessionId} text NOT NULL,`,
    `  ${c.seq} bigint GENERATED ALWAYS AS IDENTITY,`,
    `  ${c.payload} jsonb NOT NULL,`,
    `  ${c.schemaVer} int NOT NULL DEFAULT ${SCHEMA_VERSION},`,
    `  ${c.createdAt} timestamptz NOT NULL DEFAULT now(),`,
    `  PRIMARY KEY (${c.sessionId}, ${c.seq})`,
    `);`,
  ].join("\n");
}
