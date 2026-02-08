/**
 * SQLite Session Store
 *
 * Uses Node.js native SQLite (v22.5.0+) for session persistence.
 * Falls back gracefully if SQLite is not available.
 */

import type { SessionSnapshot, SessionStore, SqliteStoreConfig, StoreConfig } from "./types";

// Re-export the config type for convenience
export type { SqliteStoreConfig as SqliteSessionStoreConfig } from "./types";

/**
 * SQLite-based session store using Node.js native SQLite.
 *
 * Requires Node.js v22.5.0+ with native SQLite support.
 *
 * @example In-memory (default)
 * ```typescript
 * const store = new SqliteSessionStore();
 * ```
 *
 * @example File-based persistence
 * ```typescript
 * const store = new SqliteSessionStore({ path: './sessions.db' });
 * ```
 *
 * @example Custom table name
 * ```typescript
 * const store = new SqliteSessionStore({
 *   path: './data/app.db',
 *   table: 'user_sessions',
 * });
 * ```
 */
// Lazy-loaded SQLite module
let sqliteModule: any = null;

async function loadSqlite(): Promise<any> {
  if (sqliteModule) return sqliteModule;
  try {
    // Dynamic import works in both ESM and CJS
    sqliteModule = await import("node:sqlite");
    return sqliteModule;
  } catch (error) {
    throw new Error(
      `SQLite session store requires Node.js v22.5.0+ with native SQLite support. ` +
        `Current Node.js version: ${process.version}. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class SqliteSessionStore implements SessionStore {
  private db: any; // node:sqlite DatabaseSync
  private readonly tableName: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: Omit<SqliteStoreConfig, "type"> = {}) {
    const path = config.path ?? ":memory:";
    this.tableName = config.table ?? "agentick_sessions";

    // Start async initialization
    this.initPromise = this.initAsync(path);
  }

  private async initAsync(path: string): Promise<void> {
    const sqlite = await loadSqlite();
    this.db = new sqlite.DatabaseSync(path);
    this.initTable();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  private initTable(): void {
    if (this.initialized) return;

    // Create table if not exists
    // Using TEXT for JSON storage, with created_at and updated_at for debugging
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        session_id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create index on updated_at for LRU queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_updated_at
      ON ${this.tableName}(updated_at)
    `);

    this.initialized = true;
  }

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    await this.ensureInitialized();
    const now = Date.now();
    const json = JSON.stringify(snapshot);

    // Upsert: insert or replace
    const stmt = this.db.prepare(`
      INSERT INTO ${this.tableName} (session_id, snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        snapshot = excluded.snapshot,
        updated_at = excluded.updated_at
    `);

    stmt.run(sessionId, json, now, now);
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`
      SELECT snapshot FROM ${this.tableName} WHERE session_id = ?
    `);

    const row = stmt.get(sessionId);
    if (!row) return null;

    // Update access time (for potential LRU tracking)
    const updateStmt = this.db.prepare(`
      UPDATE ${this.tableName} SET updated_at = ? WHERE session_id = ?
    `);
    updateStmt.run(Date.now(), sessionId);

    return JSON.parse(row.snapshot);
  }

  async delete(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`
      DELETE FROM ${this.tableName} WHERE session_id = ?
    `);
    stmt.run(sessionId);
  }

  async list(): Promise<string[]> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`
      SELECT session_id FROM ${this.tableName} ORDER BY updated_at DESC
    `);
    const rows = stmt.all();
    return rows.map((row: { session_id: string }) => row.session_id);
  }

  async has(sessionId: string): Promise<boolean> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`
      SELECT 1 FROM ${this.tableName} WHERE session_id = ? LIMIT 1
    `);
    const row = stmt.get(sessionId);
    return row !== undefined;
  }

  /**
   * Get the number of stored sessions.
   */
  async count(): Promise<number> {
    await this.ensureInitialized();
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`);
    const row = stmt.get();
    return row?.count ?? 0;
  }

  /**
   * Delete sessions older than the specified age.
   * Useful for cleanup of abandoned sessions.
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of sessions deleted
   */
  async deleteOlderThan(maxAgeMs: number): Promise<number> {
    await this.ensureInitialized();
    const cutoff = Date.now() - maxAgeMs;
    const stmt = this.db.prepare(`
      DELETE FROM ${this.tableName} WHERE updated_at < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes ?? 0;
  }

  /**
   * Delete the oldest sessions to enforce a maximum count.
   * Uses LRU (least recently updated) ordering.
   *
   * @param maxCount - Maximum number of sessions to keep
   * @returns Number of sessions deleted
   */
  async enforceMaxCount(maxCount: number): Promise<number> {
    await this.ensureInitialized();
    // Delete all but the most recent maxCount sessions
    const stmt = this.db.prepare(`
      DELETE FROM ${this.tableName}
      WHERE session_id NOT IN (
        SELECT session_id FROM ${this.tableName}
        ORDER BY updated_at DESC
        LIMIT ?
      )
    `);
    const result = stmt.run(maxCount);
    return result.changes ?? 0;
  }

  /**
   * Close the database connection.
   * Call this when shutting down the application.
   */
  async close(): Promise<void> {
    await this.ensureInitialized();
    if (this.db) {
      this.db.close();
    }
  }
}

/**
 * Check if SQLite is available in the current Node.js version.
 */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a session store from configuration.
 *
 * @param config - Store configuration (string path, config object, or SessionStore)
 * @returns A SessionStore instance
 */
export function createSessionStore(config: StoreConfig | undefined): SessionStore | undefined {
  if (!config) {
    return undefined;
  }

  // String path → SQLite store
  if (typeof config === "string") {
    return new SqliteSessionStore({ path: config });
  }

  // Config object with type: 'sqlite'
  if ("type" in config && config.type === "sqlite") {
    return new SqliteSessionStore(config);
  }

  // Already a SessionStore instance
  if ("save" in config && "load" in config && "delete" in config) {
    return config as SessionStore;
  }

  throw new Error(
    `Invalid session store configuration. Expected a file path string, ` +
      `a { type: 'sqlite', ... } config object, or a SessionStore instance.`,
  );
}
