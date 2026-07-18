/**
 * Honest UDP telemetry health tracking.
 *
 * The socket existing, or being bound, is NOT the same as telemetry actually
 * flowing — this module exists specifically so nothing ever reports
 * "connected" without recent packets to back it up. States are driven by
 * real signals only (bind success/failure, packet arrival timing, hijack
 * detection) — never inferred from anything else.
 *
 * This is a pure in-memory tracker with no UI of its own in this phase; it
 * logs its own state transitions (durable diagnostic value today) and
 * exposes snapshot() for a future diagnostics panel to read.
 */
import { log } from '../utils/logger'

export type HealthState =
  | 'STARTING'           // process is booting, socket not bound yet
  | 'LISTENING'          // socket bound, no packets yet, still within the initial grace period
  | 'WAITING_FOR_GAME'   // socket bound, no packets yet, grace period elapsed — genuinely idle, not broken
  | 'RECEIVING'          // packets have arrived within the last STALE_PACKET_MS
  | 'DEGRADED'           // packets WERE arriving, then stopped — was connected, now isn't
  | 'PORT_CONFLICT'      // another process holds a more-specific bind and is eating our packets
  | 'CONFIGURATION_ERROR' // the configured port could not be bound (EADDRINUSE or similar)

export interface HealthSnapshot {
  state: HealthState
  boundPort: number | null
  packetsReceived: number
  lastPacketAt: number | null // epoch ms, null if never received one since the current bind
  listeningSince: number | null // epoch ms
  uptimeMs: number
  // Read from the raw packet header even when the format is unsupported (see
  // udp/parser.ts's parseHeader) — lets onboarding show "detected format
  // 2026, switch to 2025" instead of an indefinite spinner.
  packetFormat: number | null
  // Packets/sec over the trailing RATE_WINDOW_MS, or null once telemetry
  // stops (decays via the tick() prune, not just on the next packet).
  packetRateHz: number | null
}

// How long after a successful bind, with zero packets, before we say
// "waiting for the game" rather than just "listening" — avoids flapping
// the state during the first couple of seconds after startup.
const WAITING_GRACE_MS = 10_000
// If the last packet is older than this, telemetry has effectively stopped
// even though the socket is still open — this is what actually distinguishes
// "never connected" from "was connected, now isn't."
const STALE_PACKET_MS = 5_000
const TICK_MS = 2_000
// Trailing window used to derive packetRateHz — short enough to feel live,
// long enough that a couple of dropped UDP packets don't make the rate flap.
const RATE_WINDOW_MS = 3_000

class TelemetryHealth {
  private state: HealthState = 'STARTING'
  private boundPort: number | null = null
  private packetsReceived = 0
  private lastPacketAt: number | null = null
  private listeningSince: number | null = null
  private readonly processStartedAt = Date.now()
  private timer: NodeJS.Timeout | null = null
  private packetFormat: number | null = null
  private packetTimestamps: number[] = []
  private stateChangeListeners: Array<(snapshot: HealthSnapshot) => void> = []

  private setState(next: HealthState): void {
    if (next === this.state) return
    log.info(`Telemetry health: ${this.state} -> ${next}`)
    this.state = next
    this.notifyListeners()
  }

  private notifyListeners(): void {
    const snapshot = this.snapshot()
    for (const cb of this.stateChangeListeners) cb(snapshot)
  }

  /** Register a listener invoked with the current snapshot on every state
   *  transition, AND once per tick() as a heartbeat (see tick() — a long
   *  stable RECEIVING period never transitions, so transition-only pushes
   *  would let the server's cached snapshot go stale even though telemetry
   *  is flowing fine). Mirrors SessionLifecycle's onStateChange, adapted to
   *  a registration method (rather than constructor injection) so this
   *  stays a bare singleton, matching every existing call site. */
  onStateChange(cb: (snapshot: HealthSnapshot) => void): void {
    this.stateChangeListeners.push(cb)
  }

  onListening(port: number): void {
    this.boundPort = port
    this.listeningSince = Date.now()
    this.lastPacketAt = null
    this.setState('LISTENING')
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  onPacket(packetFormat?: number): void {
    this.packetsReceived++
    this.lastPacketAt = Date.now()
    if (packetFormat != null) this.packetFormat = packetFormat
    this.packetTimestamps.push(this.lastPacketAt)
    this.pruneTimestamps()
    this.setState('RECEIVING')
  }

  onBindError(): void {
    this.boundPort = null
    this.setState('CONFIGURATION_ERROR')
  }

  onPortHijacked(): void {
    this.setState('PORT_CONFLICT')
  }

  private pruneTimestamps(): void {
    const cutoff = Date.now() - RATE_WINDOW_MS
    while (this.packetTimestamps.length && this.packetTimestamps[0] < cutoff) this.packetTimestamps.shift()
  }

  private tick(): void {
    // Prune here too (not just in onPacket) so the rate actually decays to 0
    // once packets stop, instead of staying frozen at its last nonzero value.
    this.pruneTimestamps()

    // A genuine bind/config failure or hijack only clears when a fresh
    // successful bind or packet arrives (via onListening/onPacket above) —
    // the periodic tick never overrides those states on its own.
    if (this.state === 'PORT_CONFLICT' || this.state === 'CONFIGURATION_ERROR' || this.state === 'STARTING') {
      this.notifyListeners()
      return
    }

    const now = Date.now()
    if (this.lastPacketAt == null) {
      if (this.listeningSince != null && now - this.listeningSince > WAITING_GRACE_MS) {
        this.setState('WAITING_FOR_GAME')
      } else {
        this.notifyListeners()
      }
      return
    }
    const next = now - this.lastPacketAt > STALE_PACKET_MS ? 'DEGRADED' : 'RECEIVING'
    if (next === this.state) this.notifyListeners() // heartbeat — setState() itself would no-op on an unchanged state
    else this.setState(next)
  }

  snapshot(): HealthSnapshot {
    return {
      state: this.state,
      boundPort: this.boundPort,
      packetsReceived: this.packetsReceived,
      lastPacketAt: this.lastPacketAt,
      listeningSince: this.listeningSince,
      uptimeMs: Date.now() - this.processStartedAt,
      packetFormat: this.packetFormat,
      packetRateHz: this.packetTimestamps.length ? Math.round((this.packetTimestamps.length / (RATE_WINDOW_MS / 1000)) * 10) / 10 : null,
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export const telemetryHealth = new TelemetryHealth()
