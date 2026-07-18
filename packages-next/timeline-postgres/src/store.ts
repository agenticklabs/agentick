/**
 * `postgresTimelineStore` — Postgres {@link TimelineStore} adapter (ADR 49,
 * reference-adapter rung 4, the cloud pole). The **shared source of truth
 * across stateless replicas**: any node rehydrates a session with
 * `read(sessionId)`; SQLite-on-local-disk cannot fill this role.
 *
 * Per ADR 49's "NO `define*` helper" amendment, this follows the
 * `CredentialsStore` precedent exactly — a factory returning an object that
 * `implements TimelineStore` DIRECTLY. No intermediate wrapper.
 *
 * ## The `seq` contract, satisfied by IDENTITY
 *
 * `seq` is a `bigint GENERATED ALWAYS AS IDENTITY` column — DB-assigned,
 * strictly increasing, never reused, and never reset by `DELETE`. This
 * satisfies the port's frozen `seq` contract out of the box:
 *
 *   - **strictly increasing within a session** — IDENTITY is globally
 *     monotonic, so any single session's rows carry an increasing `seq`
 *     subsequence (start value + contiguity are implementation-defined);
 *   - **never reused** — IDENTITY never hands back a retired value, and
 *     `prune`/`delete` do not reset the sequence generator;
 *   - **stable across `prune`** — survivors keep their `seq`; a `prune`d
 *     session's next append continues past the high-water mark.
 *
 * Note vs. {@link MemoryTimelineStore}: after `delete`, Memory restarts a
 * session's `seq` at 0; Postgres continues the global IDENTITY. Both are
 * conformant — the suite asserts strictly-increasing/never-reused, not a
 * particular start value.
 *
 * `bigint` overflows JS's safe-integer range only past 2^53 entries; the
 * driver returns it as a string and this adapter coerces with `Number`.
 * The port types `seq` as `number`, so that ceiling is the port's, not
 * this adapter's.
 *
 * ## Escape hatches — the library never owns your schema
 *
 * `executor` (BYO pool), `table`, `columns`, `sql` (per-op full override),
 * `codec` (jsonb + schema_ver), `migrate` — see {@link PostgresTimelineStoreOptions}.
 *
 * ## Performance
 *
 * The write-behind pump hands `append` a **batch** → ONE multi-row
 * `INSERT ... RETURNING seq` (one round-trip per flush, not per entry).
 * Reads are cold (hydration once per open) over the PK index
 * `(session_id, seq)`. The default codec is near-zero: pg serializes the
 * entry object to `jsonb` and parses it back on read.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 */

import type { Pool as PgPool } from "pg";

import type { SeqTagged, TimelineEntry, TimelineStore } from "@agentick/timeline-next";

import {
  DEFAULT_COLUMNS,
  DEFAULT_TABLE,
  postgresTimelineSchemaSql,
  quoteIdent,
  SCHEMA_VERSION,
  type TimelineColumns,
} from "./schema.js";

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

/**
 * Per-operation FULL SQL overrides. Each is a **function** the store calls
 * with the operation's inputs, returning the exact statement to run — the
 * honest "full control" seam for partitioned / encrypted / multi-tenant
 * schemas (a static string can't express `append`'s variable row count).
 *
 * Contract for what each override MUST project (aliased to the configured
 * column names), so the store can read results back:
 *
 *   - `append` → `RETURNING <seq>` (one row per inserted entry);
 *   - `read` → rows with `<payload>` and `<schemaVer>`, in `seq` order;
 *   - `keys` → rows with `<sessionId>`;
 *   - `delete` → `RETURNING <seq>` (the store counts rows);
 *   - `prune` → `RETURNING <seq>` (the store counts rows).
 */
export interface TimelineSqlOverrides {
  append?(input: { sessionId: string; payloads: readonly unknown[] }): SqlQuery;
  read?(input: { sessionId: string }): SqlQuery;
  keys?(): SqlQuery;
  delete?(input: { sessionId: string }): SqlQuery;
  prune?(input: { sessionId: string; beforeSeq: number }): SqlQuery;
}

/**
 * Payload codec — jsonb encode/decode with schema-on-read versioning.
 * Default is identity: the entry object goes to the driver as a `jsonb`
 * param and comes back parsed. Adopters encrypt, compress, or migrate
 * per `schemaVer` here.
 */
export interface TimelineCodec {
  /** entry → the value written to the `payload` (jsonb) column. */
  encode(entry: TimelineEntry): unknown;
  /** stored payload + its `schema_ver` → entry (run pure migrations here). */
  decode(payload: unknown, schemaVer: number): TimelineEntry;
}

export interface PostgresTimelineStoreOptions {
  /**
   * **BYO** connection: a `pg.Pool` or any `{ query(text, values?) }`
   * shape. The adapter NEVER creates or owns a pool and NEVER manages its
   * lifecycle — closing it is the adopter's job.
   */
  readonly executor: PgPool | QueryExecutor;
  /** Table name. Default `"agentick_timeline"`. */
  readonly table?: string;
  /** Logical → physical column names. Defaults to snake_case. */
  readonly columns?: Partial<TimelineColumns>;
  /** Per-operation full SQL overrides. Absent ops use generated SQL. */
  readonly sql?: TimelineSqlOverrides;
  /** jsonb payload codec. Default identity. */
  readonly codec?: TimelineCodec;
  /**
   * `"off"` (default) — never run DDL; the adopter applies
   * {@link postgresTimelineSchemaSql} via their own migration tooling.
   * `"create-if-absent"` — run `CREATE TABLE IF NOT EXISTS` once, lazily,
   * before the first operation.
   */
  readonly migrate?: "off" | "create-if-absent";
}

const IDENTITY_CODEC: TimelineCodec = {
  encode: (entry) => entry,
  decode: (payload) => payload as TimelineEntry,
};

class PostgresTimelineStore implements TimelineStore {
  readonly backend = "postgres" as const;

  private readonly exec: QueryExecutor;
  private readonly table: string;
  private readonly cols: TimelineColumns;
  private readonly sql?: TimelineSqlOverrides;
  private readonly codec: TimelineCodec;
  private readonly migrate: "off" | "create-if-absent";

  /** Quoted identifiers, computed once. */
  private readonly q: { table: string } & Record<keyof TimelineColumns, string>;

  /** Lazy one-shot migration guard. */
  private migrated?: Promise<void>;

  constructor(options: PostgresTimelineStoreOptions) {
    this.exec = options.executor;
    this.table = options.table ?? DEFAULT_TABLE;
    this.cols = { ...DEFAULT_COLUMNS, ...options.columns };
    this.sql = options.sql;
    this.codec = options.codec ?? IDENTITY_CODEC;
    this.migrate = options.migrate ?? "off";
    this.q = {
      table: quoteIdent(this.table),
      sessionId: quoteIdent(this.cols.sessionId),
      seq: quoteIdent(this.cols.seq),
      payload: quoteIdent(this.cols.payload),
      schemaVer: quoteIdent(this.cols.schemaVer),
      createdAt: quoteIdent(this.cols.createdAt),
    };
  }

  /** Run `CREATE TABLE IF NOT EXISTS` at most once when opted in. */
  private ready(): Promise<void> {
    if (this.migrate === "off") return Promise.resolve();
    return (this.migrated ??= this.exec
      .query(postgresTimelineSchemaSql(this.table, this.cols))
      .then(() => undefined));
  }

  private async run(query: SqlQuery): Promise<ReadonlyArray<Record<string, unknown>>> {
    await this.ready();
    const result = await this.exec.query(query.text, query.values);
    return result.rows;
  }

  private toSeq(row: Record<string, unknown>): number {
    // pg returns bigint (int8) as a string to avoid precision loss.
    return Number(row[this.cols.seq]);
  }

  private toEntry(row: Record<string, unknown>): TimelineEntry {
    const schemaVer = Number(row[this.cols.schemaVer] ?? SCHEMA_VERSION);
    return this.codec.decode(row[this.cols.payload], schemaVer);
  }

  async read(sessionId: string): Promise<readonly TimelineEntry[]> {
    const query =
      this.sql?.read?.({ sessionId }) ??
      ({
        text: `SELECT ${this.q.payload}, ${this.q.schemaVer} FROM ${this.q.table} WHERE ${this.q.sessionId} = $1 ORDER BY ${this.q.seq}`,
        values: [sessionId],
      } satisfies SqlQuery);
    const rows = await this.run(query);
    return rows.map((r) => this.toEntry(r));
  }

  async history(
    sessionId: string,
    options?: { readonly fromSeq?: number; readonly limit?: number },
  ): Promise<readonly SeqTagged<TimelineEntry>[]> {
    const fromSeq = options?.fromSeq ?? 0;
    const values: unknown[] = [sessionId, fromSeq];
    let text =
      `SELECT ${this.q.seq}, ${this.q.payload}, ${this.q.schemaVer} FROM ${this.q.table}` +
      ` WHERE ${this.q.sessionId} = $1 AND ${this.q.seq} >= $2 ORDER BY ${this.q.seq}`;
    if (options?.limit !== undefined) {
      values.push(options.limit);
      text += ` LIMIT $3`;
    }
    const rows = await this.run({ text, values });
    return rows.map(
      (r): SeqTagged<TimelineEntry> => ({ seq: this.toSeq(r), entry: this.toEntry(r) }),
    );
  }

  async append(sessionId: string, entries: readonly TimelineEntry[]): Promise<readonly number[]> {
    if (entries.length === 0) return [];
    const payloads = entries.map((e) => this.codec.encode(e));
    const query =
      this.sql?.append?.({ sessionId, payloads }) ?? this.defaultAppendSql(sessionId, payloads);
    const rows = await this.run(query);
    // RETURNING order matches VALUES order, and IDENTITY is monotonic in
    // that order — sort ascending to guarantee input-order correspondence.
    return rows.map((r) => this.toSeq(r)).sort((a, b) => a - b);
  }

  private defaultAppendSql(sessionId: string, payloads: readonly unknown[]): SqlQuery {
    // Insert (session_id, payload) only; seq is IDENTITY and schema_ver
    // defaults. Multi-row VALUES → one round-trip.
    const rows = payloads.map((_, i) => `($1, $${i + 2})`).join(", ");
    return {
      text: `INSERT INTO ${this.q.table} (${this.q.sessionId}, ${this.q.payload}) VALUES ${rows} RETURNING ${this.q.seq}`,
      values: [sessionId, ...payloads],
    };
  }

  async keys(): Promise<readonly string[]> {
    const query =
      this.sql?.keys?.() ??
      ({
        text: `SELECT DISTINCT ${this.q.sessionId} FROM ${this.q.table}`,
        values: [],
      } satisfies SqlQuery);
    const rows = await this.run(query);
    return rows.map((r) => String(r[this.cols.sessionId]));
  }

  async delete(sessionId: string): Promise<boolean> {
    const query =
      this.sql?.delete?.({ sessionId }) ??
      ({
        // RETURNING so the count works with the minimal `{ rows }` executor.
        text: `DELETE FROM ${this.q.table} WHERE ${this.q.sessionId} = $1 RETURNING ${this.q.seq}`,
        values: [sessionId],
      } satisfies SqlQuery);
    const rows = await this.run(query);
    return rows.length > 0;
  }

  async prune(sessionId: string, before: { seq: number }): Promise<number> {
    const query =
      this.sql?.prune?.({ sessionId, beforeSeq: before.seq }) ??
      ({
        text: `DELETE FROM ${this.q.table} WHERE ${this.q.sessionId} = $1 AND ${this.q.seq} < $2 RETURNING ${this.q.seq}`,
        values: [sessionId, before.seq],
      } satisfies SqlQuery);
    const rows = await this.run(query);
    return rows.length;
  }
}

/**
 * Construct a Postgres-backed {@link TimelineStore}. BYO `pg.Pool` via
 * `executor`; the adapter never owns the pool's lifecycle.
 */
export function postgresTimelineStore(options: PostgresTimelineStoreOptions): TimelineStore {
  return new PostgresTimelineStore(options);
}
