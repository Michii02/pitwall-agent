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
}

/** Parse "host:port,host:port" — invalid entries are skipped with a warning. */
export function parseRelayTargets(raw: string | undefined): RelayTarget[] {
  if (!raw?.trim()) return []
  const targets: RelayTarget[] = []
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = entry.match(/^(.+):(\d+)$/)
    if (!m) {
      log.warn(`Ignoring invalid FORWARD_TARGETS entry "${entry}" — expected host:port`)
      continue
    }
    const port = Number(m[2])
    if (port < 1 || port > 65535) {
      log.warn(`Ignoring invalid FORWARD_TARGETS entry "${entry}" — port out of range`)
      continue
    }
    targets.push({ host: m[1], port })
  }
  return targets
}

export class TelemetryRelay {
  private socket: dgram.Socket
  private targets: RelayTarget[]
  private forwardedCount = 0
  private errorLogged = new Set<string>()

  constructor(targets: RelayTarget[]) {
    this.targets = targets
    this.socket = dgram.createSocket('udp4')
    // Prevent unhandled 'error' from crashing the process on a bad target
    this.socket.on('error', (err) => log.debug(`Relay socket error: ${err.message}`))
    if (targets.length > 0) {
      log.info(`Telemetry relay active — forwarding to: ${targets.map((t) => `${t.host}:${t.port}`).join(', ')}`)
    }
  }

  get active(): boolean {
    return this.targets.length > 0
  }

  /** Forward a raw packet, unmodified, to every configured target. Best-effort. */
  forward(buf: Buffer): void {
    if (this.targets.length === 0) return
    for (const target of this.targets) {
      this.socket.send(buf, target.port, target.host, (err) => {
        if (err) {
          const key = `${target.host}:${target.port}`
          if (!this.errorLogged.has(key)) {
            this.errorLogged.add(key)
            log.warn(`Relay forward to ${key} failed: ${err.message} (further errors to this target suppressed)`)
          }
          return
        }
        this.forwardedCount++
      })
    }
  }

  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }
}
