/**
 * Local SQLite queue — buffers in-progress sessions and queues completed
 * sessions for sync when offline or the API is down.
 */

import Database from 'better-sqlite3'
import { DB_PATH } from '../config'
import type { SessionRecord } from '../session/collector'

export type SessionStatus = 'in_progress' | 'complete' | 'queued' | 'synced' | 'failed'

const MAX_BUFFER = 50

export class SessionQueue {
  private db: Database.Database

  constructor() {
    this.db = new Database(DB_PATH)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_buffer (
        id           TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        status       TEXT NOT NULL CHECK(status IN ('in_progress','complete','queued','synced','failed')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        synced_at    TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        attempted_at  TEXT NOT NULL DEFAULT (datetime('now')),
        status        TEXT NOT NULL,
        error_message TEXT
      );
    `)
  }

  /** Insert or replace a session record with the given status. */
  upsert(record: SessionRecord, status: SessionStatus): void {
    this.db.prepare(`
      INSERT INTO sessions_buffer (id, session_json, status, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        session_json = excluded.session_json,
        status       = excluded.status,
        updated_at   = datetime('now')
    `).run(record.id, JSON.stringify(record), status)
    this.prune()
  }

  setStatus(id: string, status: SessionStatus): void {
    const syncedAt = status === 'synced' ? "datetime('now')" : 'synced_at'
    this.db.prepare(`
      UPDATE sessions_buffer SET status = ?, updated_at = datetime('now'), synced_at = ${syncedAt} WHERE id = ?
    `).run(status, id)
  }

  /** All sessions awaiting sync, oldest first. */
  pendingSessions(): { id: string; record: SessionRecord }[] {
    const rows = this.db.prepare(`
      SELECT id, session_json FROM sessions_buffer
      WHERE status IN ('complete', 'queued') ORDER BY created_at ASC
    `).all() as { id: string; session_json: string }[]
    return rows.map((r) => ({ id: r.id, record: JSON.parse(r.session_json) as SessionRecord }))
  }

  pendingCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM sessions_buffer WHERE status IN ('complete', 'queued')`,
    ).get() as { c: number }
    return row.c
  }

  logSyncAttempt(sessionId: string, status: string, errorMessage?: string): void {
    this.db.prepare(
      'INSERT INTO sync_log (session_id, status, error_message) VALUES (?, ?, ?)',
    ).run(sessionId, status, errorMessage ?? null)
  }

  /** Keep at most MAX_BUFFER rows — prune oldest SYNCED sessions first. */
  private prune(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM sessions_buffer').get() as { c: number }).c
    if (count <= MAX_BUFFER) return
    const excess = count - MAX_BUFFER
    this.db.prepare(`
      DELETE FROM sessions_buffer WHERE id IN (
        SELECT id FROM sessions_buffer WHERE status = 'synced'
        ORDER BY created_at ASC LIMIT ?
      )
    `).run(excess)
  }

  close(): void {
    this.db.close()
  }
}
