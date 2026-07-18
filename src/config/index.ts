/**
 * Configuration loader.
 *
 * Reads a .env file from %APPDATA%\PitWall Agent\.env (created on first run).
 * Falls back to a project-local .env in development (when APPDATA path absent).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

  dotenv.config({ path: ENV_PATH })

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
