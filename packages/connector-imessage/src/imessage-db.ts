import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IMessageRow {
  rowid: number;
  text: string;
  date: number;
  is_from_me: number;
  handle_id: string;
}

/**
 * Polls the iMessage chat.db for new incoming messages.
 *
 * Uses node:sqlite (Node 22+) to read the Messages database directly.
 * Tracks a ROWID watermark so each poll only returns new messages.
 *
 * Requires Full Disk Access in System Settings > Privacy & Security
 * for the terminal application running the agent.
 */
export class IMessageDB {
  private _db: DatabaseSync | null = null;
  private _watermark = 0;
  private readonly _handle: string;
  private readonly _dbPath: string;

  constructor(handle: string, dbPath?: string) {
    this._handle = handle;
    this._dbPath = dbPath ?? join(homedir(), "Library/Messages/chat.db");
  }

  open(): void {
    this._db = new DatabaseSync(this._dbPath, { open: true, readOnly: true } as any);
    // Initialize watermark to current max ROWID so we only get new messages
    this._watermark = this._getMaxRowId();
  }

  close(): void {
    this._db?.close();
    this._db = null;
  }

  /**
   * Poll for new incoming messages from the configured handle.
   * Returns messages with ROWID > watermark, then advances watermark.
   */
  poll(): IMessageRow[] {
    if (!this._db) return [];

    const stmt = this._db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.text as text,
        m.date as date,
        m.is_from_me as is_from_me,
        h.id as handle_id
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE h.id = ?
        AND m.ROWID > ?
        AND m.is_from_me = 0
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.ROWID ASC
    `);

    const rows = stmt.all(this._handle, this._watermark) as unknown as IMessageRow[];

    if (rows.length > 0) {
      this._watermark = rows[rows.length - 1].rowid;
    }

    return rows;
  }

  private _getMaxRowId(): number {
    if (!this._db) return 0;
    const stmt = this._db.prepare("SELECT MAX(ROWID) as max_id FROM message");
    const result = stmt.get() as { max_id: number | null } | undefined;
    return result?.max_id ?? 0;
  }
}
