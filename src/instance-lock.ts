/**
 * CRITICAL INFRASTRUCTURE — single-instance protection.
 *
 * Why this exists: the UDP receive socket is opened with `reuseAddr: true`
 * (see udp/listener.ts). On Windows, UDP's SO_REUSEADDR lets a SECOND
 * process bind() the same port successfully — unlike TCP, this never
 * raises EADDRINUSE. Without this check, two copies of the agent (e.g. the
 * HKCU auto-start launching a second copy while one is already running)
 * would both silently receive traffic non-deterministically, both relay to
 * Moza independently, and both record/sync sessions independently. This
 * lock must be acquired before the UDP socket, tray, or anything else
 * opens, and must never allow a second live instance to proceed.
 *
 * Uses a PID lock file at %APPDATA%\PitWall Agent\agent.lock, acquired via
 * exclusive file creation (fails if the file already exists — atomic at
 * the OS level, no separate check-then-create race). A stale lock left
 * behind by a crash (process no longer alive) is detected and cleared
 * automatically — the user never has to manually delete it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR } from './config'
import { log } from './utils/logger'

const LOCK_PATH = path.join(APP_DIR, 'agent.lock')

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    // Signal 0 sends nothing — it only checks whether the process exists
    // and is visible to this user. Throws ESRCH if it doesn't exist, or
    // EPERM if it exists but we lack permission (still means "alive").
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type LockResult = { acquired: true } | { acquired: false; heldByPid: number }

/**
 * Attempt to become the sole running instance. Call once, at the very
 * start of main(), before opening the UDP socket or anything else.
 */
export function acquireInstanceLock(): LockResult {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx') // 'wx' = create exclusively, fails if it already exists
    fs.writeFileSync(fd, String(process.pid))
    fs.closeSync(fd)
    return { acquired: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      // Unexpected filesystem error (permissions, missing dir, etc.) — fail
      // open rather than silently allowing a possible duplicate instance.
      log.error(`Instance lock: unexpected error creating ${LOCK_PATH}: ${(err as Error).message}`)
      return { acquired: false, heldByPid: -1 }
    }
  }

  // Lock file already exists — is the PID inside it actually still running?
  let existingPid = -1
  try {
    existingPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10)
  } catch {
    existingPid = -1
  }

  if (existingPid > 0 && isProcessAlive(existingPid)) {
    return { acquired: false, heldByPid: existingPid }
  }

  // Stale lock from a crash (process is gone) — clear it and take over.
  log.warn(`Instance lock: found a stale lock (PID ${existingPid || 'unknown'} is not running) — clearing it.`)
  try {
    fs.unlinkSync(LOCK_PATH)
  } catch {
    /* another process may have cleared it first — fall through and retry */
  }
  return acquireInstanceLock()
}

/** Release the lock on clean shutdown. Safe to call even if never acquired. */
export function releaseInstanceLock(): void {
  try {
    const owner = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10)
    if (owner === process.pid) fs.unlinkSync(LOCK_PATH)
  } catch {
    /* lock already gone, or never ours — nothing to do */
  }
}
