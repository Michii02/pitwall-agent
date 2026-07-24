/**
 * Configuration loader.
 *
 * Reads a .env file from %APPDATA%\PitWall Agent\.env (created on first run).
 * Falls back to a project-local .env in development (when APPDATA path absent).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import dotenv from 'dotenv'

// Resolve the config/data dir deterministically. Some launch contexts (a
// double-clicked shortcut with a stale env, a wscript-spawned process, etc.)
// don't have %APPDATA% set — the old fallback then pointed at a relative
// "./.config" that never contained the real .env, so the agent silently used
// built-in defaults (wrong UDP port). os.homedir() always resolves on Windows
// via USERPROFILE, so this always lands on the same real Roaming folder.
const ROAMING = process.env.APPDATA
  || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming')
    : path.join(os.homedir(), '.config'))
export const APP_DIR = path.join(ROAMING, 'PitWall Agent')
export const LOG_DIR = path.join(APP_DIR, 'logs')
export const DB_PATH = path.join(APP_DIR, 'pitwall-agent.db')
const ENV_PATH = path.join(APP_DIR, '.env')

export interface AgentConfig {
  apiUrl: string
  agentToken: string
  udpPort: number
  udpBindAddress: string
  gameVersion: 'auto' | 'f1_2023' | 'f1_2024' | 'f1_2025'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logMaxSizeMb: number
  logMaxFiles: number
  firstRun: boolean
  /** Raw "host:port,host:port" — other UDP tools (Moza Pit House, SimHub, …)
   *  to relay every telemetry packet to, so the game can point at PitWall
   *  exclusively while those tools keep working unmodified. */
  forwardTargets: string
}

// Default server the packaged agent talks to. Bake the deployed URL at package
// time by setting PITWALL_DEFAULT_API_URL (see DEPLOYMENT.md); falls back to
// localhost for local dev. Each tester can still override via PITWALL_API_URL.
const PRODUCTION_API_URL = process.env.PITWALL_DEFAULT_API_URL || 'http://localhost:3001'

const DEFAULT_ENV = `# PitWall Agent configuration
PITWALL_API_URL=${PRODUCTION_API_URL}
# Your PERSONAL pairing token from PitWall → Settings → Connected Games.
PITWALL_AGENT_TOKEN=
# 20779: F1 25 sends here; PitWall relays a copy to Moza on 20777 (below).
# This is also the built-in default so a fresh/misresolved config still lands
# on the right port for this setup rather than clashing with Moza on 20777.
UDP_PORT=20779
UDP_BIND_ADDRESS=0.0.0.0
GAME_VERSION=auto
LOG_LEVEL=info
LOG_MAX_SIZE_MB=10
LOG_MAX_FILES=3

# Comma-separated host:port list of OTHER telemetry tools to relay packets to
# (e.g. Moza Pit House, SimHub). Point F1 25's UDP output at PitWall's UDP_PORT
# above ONLY — F1 can only send to one target, so any other tool must receive
# its copy from PitWall's relay instead of listening directly.
FORWARD_TARGETS=127.0.0.1:20777
`

// A process launched interactively (double-clicked shortcut → cmd.exe → tsx)
// can end up with a stale view of this file that persists for its entire
// lifetime — confirmed in the field: such a process's own fs.readFileSync
// consistently read back a truncated, empty-token snapshot (per fs.statSync,
// dated to a much older mtime than the file's real one) across 20 retries
// spanning ~4 seconds, while every check run from outside that process — a
// separate Node invocation, PowerShell, even the same file via a different
// path — saw the file complete and correct the entire time. This is not
// a slow write settling; it's a per-process/session read-cache divergence
// (root cause not fully pinned down at the OS level, despite dedicated
// investigation) — no amount of retrying via this SAME process's own
// fs.readFileSync ever resolved it. Spawning a fresh external reader breaks
// out of that stale view and reliably sees the current file, so that's the
// real fix; a short same-process retry stays first since it's cheap and
// covers a genuine in-flight write (the mundane case this was originally
// written for).
// Every other field's fallback default happens to match DEFAULT_ENV's own
// value, so this exact failure is invisible everywhere except the token,
// which has no safe default — the agent looked "connected but never
// connects" with zero diagnostic trace before this.
const TOKEN_READ_RETRY_ATTEMPTS = 5
const TOKEN_READ_RETRY_DELAY_MS = 150

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Read a file via a fresh child process rather than this process's own fs
 *  calls — see readEnvTokenAware's comment for why that matters here. */
function readFileViaFreshProcess(filePath: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Content -LiteralPath $args[0] -Raw', '--', filePath],
      { encoding: 'utf8', timeout: 5000 },
    )
  } catch {
    return null
  }
}

function readEnvTokenAware(envPath: string): Record<string, string> {
  let parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'))
  // If the file has no PITWALL_AGENT_TOKEN key at all, that's a legitimate
  // never-paired state — don't chase it through any of the below.
  if (!('PITWALL_AGENT_TOKEN' in parsed) || parsed.PITWALL_AGENT_TOKEN) return parsed
  // No app logger here yet (configureLogger() needs this function's own
  // result first) — console.warn is the best available trace, and still
  // beats the silent failure this replaces.
  console.warn('[config] .env read back an empty PITWALL_AGENT_TOKEN on a non-first-run file — retrying the read')
  for (let attempt = 1; attempt < TOKEN_READ_RETRY_ATTEMPTS; attempt++) {
    syncSleep(TOKEN_READ_RETRY_DELAY_MS)
    parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'))
    if (parsed.PITWALL_AGENT_TOKEN) {
      console.warn(`[config] .env token recovered after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`)
      return parsed
    }
  }
  console.warn('[config] same-process retries exhausted — re-reading via an external process')
  const external = readFileViaFreshProcess(envPath)
  if (external) {
    const externalParsed = dotenv.parse(external)
    if (externalParsed.PITWALL_AGENT_TOKEN) {
      console.warn('[config] external re-read recovered the token — this process had a stale view of .env')
      return externalParsed
    }
  }
  console.warn('[config] .env token still empty after same-process retries and an external re-read — proceeding without one')
  return parsed
}

export function loadConfig(): AgentConfig {
  // Ensure app directories exist
  fs.mkdirSync(APP_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })

  let firstRun = false
  if (!fs.existsSync(ENV_PATH)) {
    // Also honour a dev .env next to the project for local development
    const devEnv = path.resolve(__dirname, '../../.env')
    if (fs.existsSync(devEnv)) {
      fs.copyFileSync(devEnv, ENV_PATH)
    } else {
      fs.writeFileSync(ENV_PATH, DEFAULT_ENV)
      firstRun = true
    }
  }

  const parsed = readEnvTokenAware(ENV_PATH)
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value
  }

  const gameVersion = (process.env.GAME_VERSION ?? 'auto') as AgentConfig['gameVersion']
  return {
    apiUrl: (process.env.PITWALL_API_URL || PRODUCTION_API_URL).replace(/\/$/, ''),
    agentToken: process.env.PITWALL_AGENT_TOKEN ?? '',
    udpPort: Number(process.env.UDP_PORT ?? 20779), // matches DEFAULT_ENV's UDP_PORT above — must not drift from it
    udpBindAddress: process.env.UDP_BIND_ADDRESS ?? '0.0.0.0',
    gameVersion: ['auto', 'f1_2023', 'f1_2024', 'f1_2025'].includes(gameVersion) ? gameVersion : 'auto',
    logLevel: (['debug', 'info', 'warn', 'error'].includes(process.env.LOG_LEVEL ?? '') ? process.env.LOG_LEVEL : 'info') as AgentConfig['logLevel'],
    logMaxSizeMb: Number(process.env.LOG_MAX_SIZE_MB ?? 10),
    logMaxFiles: Number(process.env.LOG_MAX_FILES ?? 3),
    firstRun,
    forwardTargets: process.env.FORWARD_TARGETS ?? '',
  }
}

/** Persist updated settings back to the .env file (used by tray Settings). */
export function saveConfig(partial: Partial<Record<string, string>>): void {
  const current = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : DEFAULT_ENV
  const lines = current.split(/\r?\n/)
  const map = new Map<string, string>()
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) map.set(m[1], m[2])
  }
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) map.set(k, v)
  }
  const out = ['# PitWall Agent configuration', ...[...map.entries()].map(([k, v]) => `${k}=${v}`), '']
  fs.writeFileSync(ENV_PATH, out.join('\n'))
}
