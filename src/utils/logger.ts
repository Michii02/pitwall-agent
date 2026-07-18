/**
 * File-based logger with size rotation.
 * Logs to %APPDATA%\PitWall Agent\logs\agent.log — max size / file count
 * configurable. Timestamps are ISO 8601 UTC.
 */

import fs from 'node:fs'
import path from 'node:path'
import { LOG_DIR } from '../config'

type Level = 'debug' | 'info' | 'warn' | 'error'
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: Level = 'info'
let maxSizeBytes = 10 * 1024 * 1024
let maxFiles = 3

const LOG_FILE = path.join(LOG_DIR, 'agent.log')

export function configureLogger(opts: { level: Level; maxSizeMb: number; maxFiles: number }): void {
  minLevel = opts.level
  maxSizeBytes = opts.maxSizeMb * 1024 * 1024
  maxFiles = opts.maxFiles
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size < maxSizeBytes) return
    // Shift agent.log → agent.1.log → agent.2.log …, dropping the oldest
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : path.join(LOG_DIR, `agent.${i - 1}.log`)
      const to = path.join(LOG_DIR, `agent.${i}.log`)
      if (fs.existsSync(from)) fs.renameSync(from, to)
    }
  } catch {
    /* file doesn't exist yet */
  }
}

function write(level: Level, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`
  let fileWriteFailed = false
  try {
    rotateIfNeeded()
    fs.appendFileSync(LOG_FILE, line)
  } catch (err) {
    fileWriteFailed = true
    // A disk issue is exactly the moment output matters most — never let a
    // production build go completely silent because the file write failed.
    process.stderr.write(`[logger] failed to write ${LOG_FILE}: ${(err as Error).message}\n`)
  }
  // Mirror to console in dev, or as a fallback if the file write just failed.
  if (process.env.NODE_ENV !== 'production' || fileWriteFailed) process.stdout.write(line)
}

export const log = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  filePath: LOG_FILE,
}

/** Format ms → M:SS.mmm for human-readable log lines. */
export function fmtLapTime(ms: number): string {
  if (!ms || ms <= 0) return '—'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

/** Format ms → SS.mmm for sector log lines. */
export function fmtSector(ms: number): string {
  if (!ms || ms <= 0) return '—'
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`
}
