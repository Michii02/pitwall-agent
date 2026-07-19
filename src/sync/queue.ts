/**
 * Local SQLite queue — buffers in-progress sessions and queues completed
 * sessions for sync when offline or the API is down.
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH } from '../config'
import type { SessionRecord } from '../session/collector'
import { NATIVE_BINDING_BASE64 } from './nativeBinding.generated'

export type SessionStatus = 'in_progress' | 'complete' | 'queued' | 'synced' | 'failed'

const MAX_BUFFER = 50

// Set by pkg itself on the packaged executable's process object at runtime —
// not part of Node's own types.
declare global {
  namespace NodeJS {
    interface Process {
      pkg?: unknown
    }
  }
}

/**
 * better-sqlite3's own `bindings`-based auto-discovery walks a list of
 * candidate paths via fs.existsSync, and native addons can't be dlopen'd
 * straight out of pkg's virtual snapshot filesystem anyway (dlopen needs a
 * real file on disk) — a packaged exe crashes on startup without a fix.
 *
 * pkg's own `assets`/`scripts` config-based bundling (the normally-
 * recommended fix) turned out unreliable for this project: verified via
 * pkg's --debug output that node_modules/better-sqlite3/build/Release/*.node
 * was never even attempted for inclusion despite being correctly declared in
 * package.json's `pkg.assets` (several glob variants tried) — a real gap in
 * this pkg version's asset resolution, not a config mistake. Confirmed by
 * running the packaged exe from a directory with NO adjacent node_modules
 * (simulating a real end-user download), which is the only way to catch
 * this — running it from inside the source tree falsely "worked" by
 * silently resolving against the real adjacent node_modules on disk instead
 * of the (non-existent) bundled asset.
 *
 * Reliable alternative: scripts/package.js base64-encodes the node-v108
 * binary directly into this file's sibling nativeBinding.generated.ts
 * (a plain source module, which pkg DOES bundle correctly — same mechanism
 * as every other .js/.ts file) before compiling. At runtime, decode it to a
 * real file next to the exe once, and hand better-sqlite3 that path via its
 * own documented `nativeBinding` option instead of letting it auto-search.
 * No-op outside a pkg build (NATIVE_BINDING_BASE64 is '' in dev) —
 * `new Database(DB_PATH)` behaves exactly as before there.
 */
function resolveNativeBinding(): string | undefined {
  if (!process.pkg || !NATIVE_BINDING_BASE64) return undefined
  const extracted = path.join(path.dirname(process.execPath), 'better_sqlite3.node')
  if (!fs.existsSync(extracted)) {
    fs.writeFileSync(extracted, Buffer.from(NATIVE_BINDING_BASE64, 'base64'))
  }
  return extracted
}

export class SessionQueue {
  private db: Database.Database

  constructor() {
    const nativeBinding = resolveNativeBinding()
    this.db = new Database(DB_PATH, nativeBinding ? { nativeBinding } : undefined)
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
