/**
 * Live telemetry forwarder.
 *
 * Streams parsed packets to the PitWall server's WebSocket `/agent` endpoint
 * (in the legacy message shape the browser Live page consumes) so the live
 * dashboard and the "Engineer Live" indicator keep working now that this
 * agent is the only UDP listener. Persistence is NOT done over this channel —
 * completed sessions go through POST /api/sessions/udp-ingest.
 *
 * Fire-and-forget: if the server is down, live view is silently unavailable
 * and we retry every 5 s. Session capture is unaffected.
 */

import WebSocket from 'ws'
import type { ParseResult } from '../udp/parser'
import type { AgentConfig } from '../config'
import type { HealthSnapshot } from '../health/state'
import type { AgentNetworkInfo } from '../network/interfaces'
import { log } from '../utils/logger'

// MVP1 Phase 1f — network interfaces and the currently-configured capture
// platform are a different axis from health/state.ts's UDP-signal-driven
// state (that module is deliberately left untouched, see network/interfaces.ts's
// own comment) — composed onto the health payload here at the push boundary
// instead.
export type AgentHealthPushPayload = HealthSnapshot & {
  network: AgentNetworkInfo
  capturePlatform: AgentConfig['capturePlatform']
}

// How often to ping the server once connected, and how long without a pong
// before the connection is declared dead. 'close'/'error' alone are not
// reliable: an abruptly killed server process (Stop-Process -Force, or a
// tsx-watch restart that doesn't send a clean WS close frame) can leave this
// socket looking "connected" forever on Windows loopback, with neither event
// ever firing. The server's ws library auto-replies to pings with pongs
// (ws@8.21.0 default autoPong: true) — no server-side change is required for
// these pongs to arrive.
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 35_000 // ~2.3x interval — tolerates one delayed pong under load
// Full-grid Lap Data arrives many times per second. Opponent questions do not
// need that rate, so carry the compact grid at most twice per second while the
// player-only lap message continues at its existing cadence.
const LIVE_GRID_INTERVAL_MS = 500

export class LiveForwarder {
  private ws: WebSocket | null = null
  private connected = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingInterval: NodeJS.Timeout | null = null
  private lastPongAt = 0
  private lastGridSentAt = 0
  private readonly url: string

  constructor(
    config: AgentConfig,
    /** Returns the current session snapshot — sent on connect and on demand. */
    private getSnapshot?: () => object,
    /** Returns the current UDP health snapshot (plus network/platform info,
     *  MVP1 Phase 1f) — sent on (re)connect so a fresh WS doesn't have to
     *  wait for the next state transition to learn where things already
     *  stand (e.g. telemetry was already flowing). */
    private getHealthSnapshot?: () => AgentHealthPushPayload,
  ) {
    const wsBase = config.apiUrl.replace(/^http/, 'ws')
    this.url = `${wsBase}/agent${config.agentToken ? `?token=${encodeURIComponent(config.agentToken)}` : ''}`
  }

  start(): void {
    this.connect()
  }

  private connect(): void {
    try {
      const socket = new WebSocket(this.url)
      this.ws = socket
      // Stale sockets from a previous connect() can still fire delayed events
      // after being replaced — ignore anything not from the current socket so
      // a late event can't corrupt state or double-schedule a reconnect.
      const isCurrent = () => this.ws === socket

      socket.on('open', () => {
        if (!isCurrent()) return
        this.connected = true
        this.lastPongAt = Date.now()
        log.info('Live forwarder connected to PitWall server')
        this.pushSnapshot()
        if (this.getHealthSnapshot) this.pushHealth(this.getHealthSnapshot())
        this.startHeartbeat(socket, isCurrent)
      })
      socket.on('pong', () => {
        if (!isCurrent()) return
        this.lastPongAt = Date.now()
        log.debug('Live forwarder heartbeat: pong received')
      })
      socket.on('close', () => {
        if (!isCurrent()) return
        this.stopHeartbeat()
        if (this.connected) log.info('Live forwarder disconnected — retrying in 5s')
        else log.warn('Live forwarder: connection closed before reaching open — retrying in 5s')
        this.connected = false
        this.scheduleReconnect()
      })
      socket.on('error', (err) => {
        if (!isCurrent()) return
        // Reconnect from here directly rather than relying on close() to
        // cascade into the 'close' handler above — a socket that errors
        // before ever reaching OPEN doesn't reliably emit 'close' after
        // close() is called on it, which previously left the forwarder
        // stuck disconnected forever with no reconnect ever scheduled.
        log.warn(`Live forwarder: connection error — retrying in 5s (${(err as Error).message})`)
        this.stopHeartbeat()
        this.connected = false
        this.scheduleReconnect()
        try { socket.close() } catch { /* already closing */ }
      })
    } catch (err) {
      log.warn(`Live forwarder: failed to construct WebSocket — retrying in 5s (${(err as Error).message})`)
      this.scheduleReconnect()
    }
  }

  private startHeartbeat(socket: WebSocket, isCurrent: () => boolean): void {
    this.stopHeartbeat() // defensive — a stale interval must never outlive its socket
    this.pingInterval = setInterval(() => {
      if (!isCurrent()) { this.stopHeartbeat(); return }
      const silentForMs = Date.now() - this.lastPongAt
      if (silentForMs > HEARTBEAT_TIMEOUT_MS) {
        log.warn(`Live forwarder heartbeat timed out after ${Math.round(silentForMs / 1000)}s — terminating stale connection`)
        this.stopHeartbeat()
        socket.terminate() // forces the 'close' event so the existing reconnect path runs
        return
      }
      try {
        socket.ping()
      } catch { /* socket already closing */ }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 5000)
  }

  /** Convert a parsed packet to the legacy live-view shape and send it. */
  forward(result: ParseResult): void {
    if (!this.connected || !this.ws) return
    const now = Date.now()
    const includeGrid = result.packet.kind === 'lap' && now - this.lastGridSentAt >= LIVE_GRID_INTERVAL_MS
    const msg = toLegacyMessage(result, includeGrid, now)
    if (!msg) return
    try {
      this.ws.send(JSON.stringify(msg))
      if (includeGrid) this.lastGridSentAt = now
    } catch { /* socket closing */ }
  }

  /** Send the current session snapshot ({type:'agentSession'}). The server
   *  caches the latest one and replays it to browsers that connect later. */
  pushSnapshot(): void {
    if (!this.connected || !this.ws || !this.getSnapshot) return
    try {
      this.ws.send(JSON.stringify({ type: 'agentSession', timestamp: Date.now(), data: this.getSnapshot() }))
    } catch { /* socket closing */ }
  }

  /** Send a UDP-socket health snapshot ({type:'agentHealth'}), separate from
   *  pushSnapshot()'s session-lifecycle data — health and session state are
   *  independent producers with different cadences (health reacts to
   *  bind/packet events, session to lap/session packets). The server caches
   *  this per-pairing-token and does NOT broadcast it to browsers (unlike
   *  agentSession) — see server/ws/index.ts for why. */
  pushHealth(snapshot: AgentHealthPushPayload): void {
    if (!this.connected || !this.ws) return
    try {
      this.ws.send(JSON.stringify({ type: 'agentHealth', timestamp: Date.now(), data: snapshot }))
    } catch { /* socket closing */ }
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    this.ws?.close()
  }
}

/** Map agent packet shapes → the { type, timestamp, data } messages the browser expects. */
export function toLegacyMessage(result: ParseResult, includeGrid = true, ts = Date.now()): object | null {
  const pkt = result.packet
  switch (pkt.kind) {
    case 'session':
      return {
        type: 'session', timestamp: ts,
        data: {
          weather: pkt.weather,
          trackTemperature: pkt.trackTemperature,
          airTemperature: pkt.airTemperature,
          totalLaps: pkt.totalLaps,
          sessionType: pkt.sessionType,
          trackId: pkt.trackId,
          safetyCarStatus: pkt.safetyCarStatus,
        },
      }
    case 'lap':
      {
      const player = pkt.grid?.find((entry) => entry.vehicleIndex === result.header.playerCarIndex)
      const ahead = player ? pkt.grid?.find((entry) => entry.carPosition === player.carPosition - 1) : undefined
      const behind = player ? pkt.grid?.find((entry) => entry.carPosition === player.carPosition + 1) : undefined
      return {
        type: 'lap', timestamp: ts,
        data: {
          lastLapMs: pkt.lastLapMs,
          currentLapMs: pkt.currentLapMs,
          sector1Ms: pkt.sector1Ms,
          sector2Ms: pkt.sector2Ms,
          sector: pkt.sector,
          carPosition: pkt.carPosition,
          lapNumber: pkt.lapNumber,
          pitStatus: pkt.pitStatus,
          numPitStops: pkt.numPitStops,
          currentLapInvalid: pkt.lapInvalid ? 1 : 0,
          gridPosition: pkt.gridPosition,
          driverStatus: pkt.driverStatus,
          resultStatus: pkt.resultStatus,
          playerVehicleIndex: result.header.playerCarIndex,
          gapAheadMs: player?.gapAheadMs ?? null,
          gapBehindMs: behind?.gapAheadMs ?? null,
          aheadVehicleIndex: ahead?.vehicleIndex ?? null,
          behindVehicleIndex: behind?.vehicleIndex ?? null,
          ...(includeGrid && pkt.grid ? { grid: pkt.grid.map((entry) => ({
            vehicleIndex: entry.vehicleIndex,
            carPosition: entry.carPosition,
            lapNumber: entry.lapNumber,
            pitStatus: entry.pitStatus,
            numPitStops: entry.numPitStops,
            gapAheadMs: entry.gapAheadMs,
            gapToLeaderMs: entry.gapToLeaderMs,
          })) } : {}),
        },
      }
      }
    case 'participant':
      return {
        type: 'participants', timestamp: ts,
        data: {
          playerVehicleIndex: result.header.playerCarIndex,
          participants: (pkt.grid ?? [{ vehicleIndex: result.header.playerCarIndex, driverName: pkt.driverName }])
            .map((entry) => ({ vehicleIndex: entry.vehicleIndex, driverName: entry.driverName })),
        },
      }
    case 'carTelemetry':
      return {
        type: 'carStatus', timestamp: ts,
        data: {
          kind: 'telemetry',
          speed: pkt.speed,
          throttle: pkt.throttle,
          brake: pkt.brake,
          gear: pkt.gear,
          rpm: pkt.rpm,
          drs: pkt.drs,
        },
      }
    case 'status':
      return {
        type: 'carStatus', timestamp: ts,
        data: {
          kind: 'status',
          fuelInTank: pkt.fuelInTank,
          actualTyreCompound: pkt.actualTyreCompound,
          visualTyreCompound: pkt.visualTyreCompound,
          tyresAgeLaps: pkt.tyresAgeLaps,
          ersStoreEnergy: pkt.ersStoreEnergy,
          ersDeployMode: pkt.ersDeployMode,
        },
      }
    case 'damage':
      return {
        type: 'motion', timestamp: ts,
        data: {
          kind: 'damage', tyresWear: pkt.tyreWear,
          frontLeftWing: pkt.frontLeftWing,
          frontRightWing: pkt.frontRightWing,
          rearWing: pkt.rearWing,
          floor: pkt.floor,
          diffuser: pkt.diffuser,
          sidepod: pkt.sidepod,
          gearbox: pkt.gearbox,
          engine: pkt.engine,
        },
      }
    case 'history':
      return {
        type: 'history', timestamp: ts,
        data: { bestLapNumber: pkt.bestLapNumber, laps: pkt.laps },
      }
    default:
      return null // events, setup, grid history, classification — not needed live
  }
}
