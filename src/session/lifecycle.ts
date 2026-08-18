/**
 * Session lifecycle state machine.
 *
 * IDLE → SESSION_STARTING → SESSION_ACTIVE → SESSION_ENDING → SYNCING → IDLE
 *
 * Start triggers: SSTA event, or lap packets arriving while a session packet
 * identifies an on-track session.
 * End triggers: SEND event, player result status finished/dnf, or 60 s of
 * UDP silence while active (abandoned session).
 */

import { SessionCollector, type SessionRecord, type CaptureProfile } from './collector'
import type { ParseResult } from '../udp/parser'
import { SESSION_TYPE_NAMES, type SessionPacket, type GameVersion } from '../udp/packets/common'
import { log } from '../utils/logger'

export type AgentState = 'IDLE' | 'CONNECTED' | 'SESSION_STARTING' | 'SESSION_ACTIVE' | 'SESSION_ENDING' | 'SYNCING'

const ABANDON_TIMEOUT_MS = 60_000
const CONNECTED_TIMEOUT_MS = 10_000
// A finished session's Session/Lap/Final-Classification packets keep being
// broadcast by the game while the player sits on the post-race results/
// podium screen (confirmed in production logs: rapid Session
// started→ended(0 laps)→discarded cycles, using the just-finished race's own
// stale classification). Bounded, not permanent — if this UID-based guard is
// ever wrong (e.g. a real same-UID session transition it doesn't know about),
// capture self-heals after this cooldown instead of staying blocked forever.
const SAME_SESSION_SUPPRESS_MS = 120_000

export interface LifecycleEvents {
  onStateChange: (state: AgentState, detail?: string) => void
  onSessionComplete: (record: SessionRecord) => Promise<void>
  onLapComplete: (trackName: string, lapNumber: number) => void
}

export class SessionLifecycle {
  private state: AgentState = 'IDLE'
  private collector: SessionCollector | null = null
  private lastSessionPacket: SessionPacket | null = null
  private gameVersion: GameVersion | null = null
  private lastPacketAt = 0
  private abandonTimer: NodeJS.Timeout | null = null
  private connectedTimer: NodeJS.Timeout | null = null
  // Same-session-broadcast suppression (see SAME_SESSION_SUPPRESS_MS above).
  private currentHeaderSessionUid: string | null = null
  private lastFinalizedSessionUid: string | null = null
  private lastFinalizedAt = 0
  private suppressedRestartLogged = false

  // captureProfile is optional so existing construction keeps working
  // unchanged; omitted means PC / PC_NATIVE, which is what every session
  // before League Session Intelligence effectively was.
  constructor(private events: LifecycleEvents, private captureProfile?: CaptureProfile) {}

  get currentState(): AgentState { return this.state }
  get sessionDetail(): string | null {
    if (!this.collector) return null
    return `${this.collector.record.track_name} · Lap ${this.collector.currentLap}`
  }

  /** Snapshot of the in-progress session — relayed to browsers so a UI opened
   *  mid-session attaches to the active recording immediately. */
  get snapshot(): {
    active: boolean; state: AgentState
    trackName: string | null; trackId: number | null
    sessionType: string | null; lapCount: number
  } {
    const rec = this.collector?.record ?? null
    return {
      active: !!this.collector,
      state: this.state,
      trackName: rec?.track_name ?? null,
      trackId: rec?.track_id ?? null,
      sessionType: rec?.session_type ?? null,
      lapCount: rec?.laps.length ?? 0,
    }
  }

  private setState(next: AgentState, detail?: string): void {
    if (this.state === next) return
    this.state = next
    log.debug(`State → ${next}${detail ? ` (${detail})` : ''}`)
    this.events.onStateChange(next, detail)
  }

  feed(result: ParseResult): void {
    this.lastPacketAt = Date.now()
    this.gameVersion = result.gameVersion
    this.currentHeaderSessionUid = result.header.sessionUid
    this.armTimers()

    // Any packet flow while idle means the game is running
    if (this.state === 'IDLE') this.setState('CONNECTED')

    // Race Grid Intelligence (additive): keep the collector's own record of
    // which vehicle slot is the player's up to date — self-correcting, every
    // packet carries it in the header.
    this.collector?.updatePlayerVehicleIndex(result.header.playerCarIndex)
    // Session Intelligence Repair: capture the game's own session UID once
    // per session — new diagnostic/audit evidence, never read by anything
    // that exists today.
    this.collector?.updateSessionUid(result.header.sessionUid)

    const pkt = result.packet
    switch (pkt.kind) {
      case 'session': {
        this.lastSessionPacket = pkt
        if (this.collector) {
          // A real session-type or track change (e.g. Qualifying → Race on a
          // race weekend) must close out the current session and start a
          // fresh one — otherwise everything keeps accumulating under
          // whatever type the collector was first built with. Q1→Q2→Q3 all
          // map to the same 'qualifying' string, so those correctly do NOT
          // trigger a restart — only a genuine category change does.
          const mappedType = SESSION_TYPE_NAMES[pkt.sessionType] ?? 'unknown'
          const isRealSession = pkt.sessionType !== 0 && pkt.trackId >= 0
          const typeChanged = mappedType !== this.collector.record.session_type
          const trackChanged = pkt.trackId !== this.collector.record.track_id
          if (isRealSession && (typeChanged || trackChanged)) {
            log.info(`Session change detected (${this.collector.record.session_type} → ${mappedType}) — committing previous session and starting new one`)
            this.endSession(false)
            this.lastSessionPacket = pkt
            // Bypasses the same-session guard: a live type/track change while
            // actively collecting is strong independent evidence of a real
            // transition (e.g. Qualifying → Race), regardless of whether the
            // game happens to keep the same session UID across it.
            this.startSession('session type changed', { bypassSameSessionGuard: true })
          } else {
            this.collector.updateSession(pkt)
          }
        } else if (this.state === 'SESSION_STARTING') {
          // A start was requested before we knew the track — complete it now
          this.startSession('session data arrived')
        }
        break
      }

      case 'event': {
        const player = result.header.playerCarIndex
        // Bypasses the same-session guard: SSTA is the game's own explicit
        // "a session just started" signal — as strong a real-start signal as
        // exists, independent of whatever the session UID happens to do.
        if (pkt.code === 'SSTA') this.startSession('SSTA event', { bypassSameSessionGuard: true })
        else if (pkt.code === 'SEND') this.endSession(false)
        else if (pkt.code === 'FLAP') log.info('Event · fastest lap')
        else if (pkt.code === 'RCWN') log.info('Event · race winner')
        else if (pkt.code === 'PENA' && this.collector && pkt.vehicleIdx === player) {
          this.collector.recordPenalty(pkt)
        } else if (pkt.code === 'COLL' && this.collector &&
                   (pkt.vehicleIdx === player || pkt.otherVehicleIdx === player)) {
          this.collector.recordCollision()
        }
        // Race Grid Intelligence (additive): capture penalty/collision events
        // for every car, independent of the player-only branch above.
        if (pkt.code === 'PENA' && this.collector) this.collector.recordAnyCarPenalty(pkt)
        else if (pkt.code === 'COLL' && this.collector) this.collector.recordAnyCarCollision(pkt)
        break
      }

      case 'lap': {
        // Lap packets while not collecting → implicit session start
        if (!this.collector && this.state !== 'SYNCING' && this.state !== 'SESSION_ENDING') {
          if (pkt.driverStatus > 0 || pkt.currentLapMs > 0) this.startSession('lap data flow')
        }
        // Race Grid Intelligence (additive): keep the latest full-grid Lap
        // Data snapshot fresh, used at each lap boundary inside updateLap.
        if (pkt.grid) this.collector?.updateLapDataGridSnapshot(pkt.grid)
        if (this.collector && this.state === 'SESSION_ACTIVE') {
          const completed = this.collector.updateLap(pkt)
          if (completed) {
            this.events.onLapComplete(this.collector.record.track_name, this.collector.currentLap)
          }
          // Race Context Intelligence (additive): buffered all-car proximity
          // snapshot, throttled internally — see updateProximitySnapshot.
          if (pkt.grid) this.collector.updateProximitySnapshot(pkt.grid)
          // Finished / DNF result status ends the session
          if (pkt.resultStatus === 3 || (pkt.resultStatus >= 4 && pkt.resultStatus <= 7)) {
            this.endSession(false)
          }
        }
        break
      }

      case 'participant':
        this.collector?.updateParticipant(pkt.driverName, pkt.teamId, pkt.raceNumber)
        // Race Grid Intelligence (additive)
        if (pkt.grid) this.collector?.updateParticipantsGrid(pkt.grid)
        break
      case 'setup':
        this.collector?.updateSetup(pkt)
        break
      case 'status':
        this.collector?.updateStatus(pkt)
        break
      case 'carTelemetry':
        if (this.collector && this.state === 'SESSION_ACTIVE') this.collector.updateTelemetry(pkt)
        break
      case 'damage':
        this.collector?.updateDamage(pkt)
        break
      case 'classification':
        if (this.collector) {
          this.collector.applyClassification(pkt)
          // Race Grid Intelligence (additive)
          if (pkt.grid) this.collector.applyClassificationGrid(pkt.grid)
          this.endSession(false)
        }
        break
      case 'history':
        this.collector?.applyHistory(pkt)
        break
      case 'historyGrid':
        // Race Grid Intelligence (additive) — Session History for a car
        // other than the player, previously always discarded (see
        // parseHistoryAnyCar in parser.ts).
        this.collector?.applyHistoryGrid(pkt)
        break
      case 'tyreSets':
        // Currently informational only
        break
    }
  }

  private startSession(reason: string, opts: { bypassSameSessionGuard?: boolean } = {}): void {
    if (this.collector) return
    if (!opts.bypassSameSessionGuard && this.isLikelySameFinishedSession()) {
      // The game keeps broadcasting the just-finished session's Session/Lap
      // packets while the player sits on the post-race results/podium
      // screen — this is leftover broadcast, not a new session starting.
      // Logged once per suppressed session (not per packet) to avoid
      // reproducing the exact log spam this guard exists to prevent.
      if (!this.suppressedRestartLogged) {
        this.suppressedRestartLogged = true
        log.debug(`Suppressed session restart (${reason}) — same session UID as the session just finalised`)
      }
      return
    }
    if (!this.lastSessionPacket || !this.gameVersion) {
      // Wait until we know track/type — SESSION packets arrive at 2 Hz
      this.setState('SESSION_STARTING', `awaiting session data (${reason})`)
      return
    }
    // Menus broadcast sessionType 0 / trackId -1 — don't start on those
    const s = this.lastSessionPacket
    if (s.sessionType === 0 || s.trackId < 0) return

    this.setState('SESSION_STARTING', reason)
    this.collector = new SessionCollector(this.gameVersion, s, this.captureProfile)
    this.setState('SESSION_ACTIVE')
  }

  /**
   * True when the current packet stream's session UID matches the session we
   * just finalised, within a bounded cooldown (SAME_SESSION_SUPPRESS_MS) —
   * the signal that what's arriving is leftover broadcast from a session
   * that's already over (e.g. sitting on the post-race podium/results
   * screen), not a genuinely new one. Bounded rather than permanent so a
   * wrong assumption about the game's session-UID behaviour self-heals
   * instead of silently blocking capture forever.
   */
  private isLikelySameFinishedSession(): boolean {
    return (
      this.lastFinalizedSessionUid != null &&
      this.currentHeaderSessionUid === this.lastFinalizedSessionUid &&
      Date.now() - this.lastFinalizedAt < SAME_SESSION_SUPPRESS_MS
    )
  }

  private endSession(abandoned: boolean): void {
    if (!this.collector) return
    this.setState('SESSION_ENDING')
    const record = this.collector.finalise(abandoned)
    this.lastFinalizedSessionUid = record.session_uid ?? this.currentHeaderSessionUid
    this.lastFinalizedAt = Date.now()
    this.suppressedRestartLogged = false
    this.collector = null
    this.lastSessionPacket = null

    if (record.laps.length === 0) {
      log.info('Session discarded — no completed laps')
      this.setState('IDLE')
      return
    }

    this.setState('SYNCING')
    this.events.onSessionComplete(record).finally(() => {
      // If a new session has already started (e.g. immediate Qualifying→Race
      // transition) while this sync was in flight, don't stomp on its state.
      if (this.collector) return
      this.setState(this.lastPacketAt > Date.now() - CONNECTED_TIMEOUT_MS ? 'CONNECTED' : 'IDLE')
    })
  }

  /** Re-arm the silence timers on every packet. */
  private armTimers(): void {
    if (this.abandonTimer) clearTimeout(this.abandonTimer)
    if (this.connectedTimer) clearTimeout(this.connectedTimer)

    this.abandonTimer = setTimeout(() => {
      if (this.collector) {
        log.warn('UDP silence for 60 s during active session — finalising as abandoned')
        this.endSession(true)
      }
    }, ABANDON_TIMEOUT_MS)

    this.connectedTimer = setTimeout(() => {
      if (!this.collector && this.state === 'CONNECTED') this.setState('IDLE', 'game closed')
    }, CONNECTED_TIMEOUT_MS)
  }
}
