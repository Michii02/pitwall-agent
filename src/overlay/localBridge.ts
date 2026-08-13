/**
 * Local overlay bridge — broadcasts parsed steer/throttle/brake frames to
 * same-machine consumers (e.g. the input-trace overlay app) over a loopback
 * WebSocket server.
 *
 * Why this exists: nothing in this agent exposes parsed telemetry locally —
 * `sync/live.ts` is an outbound client to the *cloud* PitWall server, and
 * `udp/relay.ts` re-sends raw, unparsed UDP bytes to other tools (Moza, etc).
 * An overlay wanting parsed data has no existing subscribe point without this.
 *
 * Bound to 127.0.0.1 only, never 0.0.0.0 — this is telemetry, kept loopback.
 * Best-effort by design, mirroring udp/relay.ts's TelemetryRelay exactly:
 * any construction/send error is caught and logged, never thrown. This must
 * never be able to block, slow, or crash the UDP receive→parse→forward path.
 *
 * Enable state has two independent gates, both funnelled through setEnabled:
 *   - OVERLAY_BRIDGE_ENABLED in .env — a local, boot-time master switch.
 *   - The driver's per-account Settings-page toggle — polled periodically by
 *     overlay/preferencePoll.ts and applied via setEnabled() at runtime, so
 *     the bridge can start/stop without restarting the agent.
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { log } from '../utils/logger'
import type { ParseResult } from '../udp/parser'

export interface OverlayFrame {
  type: 'frame'
  t: number
  steer: number
  throttle: number
  brake: number
}

export class OverlayBridge {
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private readonly port: number

  constructor(port: number, enabled: boolean) {
    this.port = port
    if (enabled) this.start()
  }

  private start(): void {
    if (this.wss) return // already running
    try {
      this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' })
      this.wss.on('connection', (ws) => {
        this.clients.add(ws)
        ws.on('close', () => this.clients.delete(ws))
        ws.on('error', () => this.clients.delete(ws))
      })
      this.wss.on('error', (err) => {
        log.warn(`Overlay bridge disabled — failed to bind 127.0.0.1:${this.port}: ${err.message}`)
        this.wss = null
      })
      log.info(`Overlay bridge listening on ws://127.0.0.1:${this.port} (local input-trace overlay only)`)
    } catch (err) {
      log.warn(`Overlay bridge failed to start: ${(err as Error).message}`)
      this.wss = null
    }
  }

  get active(): boolean {
    return this.wss != null
  }

  /** Starts or stops the bridge to match the desired state. Safe to call repeatedly. */
  setEnabled(enabled: boolean): void {
    if (enabled && !this.wss) {
      this.start()
    } else if (!enabled && this.wss) {
      log.info('Overlay bridge disabled (Settings preference)')
      this.close()
    }
  }

  /** Forward one already-parsed packet's telemetry, if it's the right kind. Best-effort. */
  forward(result: ParseResult): void {
    if (!this.wss || this.clients.size === 0) return
    if (result.packet.kind !== 'carTelemetry') return
    const p = result.packet
    const frame: OverlayFrame = { type: 'frame', t: Date.now(), steer: p.steer, throttle: p.throttle, brake: p.brake }
    const json = JSON.stringify(frame)
    for (const ws of this.clients) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(json)
      } catch (err) {
        log.debug(`Overlay bridge send failed: ${(err as Error).message}`)
      }
    }
  }

  close(): void {
    try { this.wss?.close() } catch { /* already closed */ }
    this.wss = null
    this.clients.clear()
  }
}
