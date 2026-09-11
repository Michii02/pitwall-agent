/**
 * Telemetry relay — forwards every raw UDP packet the agent receives to a
 * configurable list of downstream consumers (Moza Pit House, SimHub, etc.)
 * unmodified and immediately.
 *
 * Why this exists: F1's telemetry output is unicast to exactly one
 * configured IP:port. Windows delivers each datagram to the socket with the
 * most specific binding — it does NOT fan a unicast packet out to multiple
 * listeners bound to the same port, even with SO_REUSEADDR (that only
 * applies to multicast/broadcast). So two apps cannot both "just listen" on
 * the game's UDP port; one of them silently gets nothing.
 *
 * The fix used by every tool that coexists with others (TrackTitan, SimHub,
 * etc.) is the same: become the single exclusive receiver, then relay a raw
 * copy of each packet on to the other tools' own listening ports. Nothing
 * is parsed or altered in the relayed copy — downstream tools see identical
 * bytes to what the game sent.
 */

import dgram from 'node:dgram'
import { log } from '../utils/logger'

export interface RelayTarget {
  host: string
  port: number
  name?: string
  enabled?: boolean
}

export interface RelayTargetSnapshot {
  name: string
  host: string
  port: number
  enabled: boolean
  packetsForwarded: number
  lastSuccessfulSendAt: number | null
  errorCount: number
  lastError: string | null
}

export interface RelaySnapshot {
  active: boolean
  totalPacketsForwarded: number
  targets: RelayTargetSnapshot[]
}

/**
 * Parse comma-separated targets. Existing `host:port` values remain valid;
 * `Name=host:port` assigns a display name and a leading `!` disables a target.
 */
export function parseRelayTargets(raw: string | undefined): RelayTarget[] {
  if (!raw?.trim()) return []
  const targets: RelayTarget[] = []
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const enabled = !entry.startsWith('!')
    const configured = enabled ? entry : entry.slice(1).trim()
    const separator = configured.indexOf('=')
    const name = separator >= 0 ? configured.slice(0, separator).trim() : undefined
    const destination = separator >= 0 ? configured.slice(separator + 1).trim() : configured
    const m = destination.match(/^(.+):(\d+)$/)
    if (!m) {
      log.warn(`Ignoring invalid FORWARD_TARGETS entry "${entry}" — expected [!][name=]host:port`)
      continue
    }
    const port = Number(m[2])
    if (port < 1 || port > 65535) {
      log.warn(`Ignoring invalid FORWARD_TARGETS entry "${entry}" — port out of range`)
      continue
    }
    targets.push({ host: m[1], port, ...(name ? { name } : {}), enabled })
  }
  return targets
}

export class TelemetryRelay {
  private socket: dgram.Socket
  private targets: RelayTarget[]
  private forwardedCount = 0
  private errorLogged = new Set<string>()
  private targetHealth: RelayTargetSnapshot[]

  constructor(targets: RelayTarget[]) {
    this.targets = targets
    this.targetHealth = targets.map((target) => ({
      name: target.name ?? `${target.host}:${target.port}`,
      host: target.host,
      port: target.port,
      enabled: target.enabled !== false,
      packetsForwarded: 0,
      lastSuccessfulSendAt: null,
      errorCount: 0,
      lastError: null,
    }))
    this.socket = dgram.createSocket('udp4')
    // Prevent unhandled 'error' from crashing the process on a bad target
    this.socket.on('error', (err) => log.debug(`Relay socket error: ${err.message}`))
    if (this.active) {
      log.info(`Telemetry relay active — forwarding to: ${targets.filter((t) => t.enabled !== false).map((t) => `${t.host}:${t.port}`).join(', ')}`)
    }
  }

  get active(): boolean {
    return this.targetHealth.some((target) => target.enabled)
  }

  snapshot(): RelaySnapshot {
    return {
      active: this.active,
      totalPacketsForwarded: this.forwardedCount,
      targets: this.targetHealth.map((target) => ({ ...target })),
    }
  }

  /** Forward a raw packet, unmodified, to every configured target. Best-effort. */
  forward(buf: Buffer): void {
    if (this.targets.length === 0) return
    for (let index = 0; index < this.targets.length; index++) {
      const target = this.targets[index]
      const health = this.targetHealth[index]
      if (!health.enabled) continue
      this.socket.send(buf, target.port, target.host, (err) => {
        if (err) {
          health.errorCount++
          health.lastError = err.message
          const key = `${target.host}:${target.port}`
          if (!this.errorLogged.has(key)) {
            this.errorLogged.add(key)
            log.warn(`Relay forward to ${key} failed: ${err.message} (further errors to this target suppressed)`)
          }
          return
        }
        this.forwardedCount++
        health.packetsForwarded++
        health.lastSuccessfulSendAt = Date.now()
        health.lastError = null
      })
    }
  }

  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }
}
