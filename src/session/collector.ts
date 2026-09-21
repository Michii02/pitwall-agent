/**
 * Session collector — assembles parsed packets into the PitWall session
 * record (Part 4 data model). Purely an accumulator; lifecycle.ts decides
 * when to start, finalise, and hand off for sync.
 */

import { randomUUID } from 'node:crypto'
import {
  TRACK_NAMES, TEAM_NAMES, SESSION_TYPE_NAMES, WEATHER_NAMES, VISUAL_COMPOUND_NAMES,
  PENALTY_TYPE_NAMES, INFRINGEMENT_NAMES,
  type GameVersion, type SessionPacket, type LapPacket, type SetupPacket,
  type StatusPacket, type DamagePacket, type ClassificationPacket, type HistoryPacket,
  type EventPacket, type CarTelemetryPacket,
  type ParticipantGridEntry, type LapGridEntry, type ClassificationGridEntry, type HistoryGridPacket,
} from '../udp/packets/common'
import { deriveVehicleEra, type VehicleEra } from './vehicleEra'
import { log, fmtLapTime, fmtSector } from '../utils/logger'

export interface LapRecord {
  lap_number: number
  lap_time_ms: number
  sector_1_ms: number
  sector_2_ms: number
  sector_3_ms: number
  lap_valid: boolean
  tyre_wear_fl: number | null
  tyre_wear_fr: number | null
  tyre_wear_rl: number | null
  tyre_wear_rr: number | null
  tyre_compound: string | null
  tyre_age: number | null
  fuel_load: number | null
  car_position: number | null
  pit_this_lap: boolean
  safety_car_this_lap: boolean
}

export interface StintRecord {
  stint_number: number
  compound: string | null
  start_lap: number
  end_lap: number
  tyre_wear_start_fl: number | null
  tyre_wear_start_fr: number | null
  tyre_wear_start_rl: number | null
  tyre_wear_start_rr: number | null
  tyre_wear_end_fl: number | null
  tyre_wear_end_fr: number | null
  tyre_wear_end_rl: number | null
  tyre_wear_end_rr: number | null
}

export interface TelemetrySample {
  gap_before?: boolean
  t: number          // ms since session start
  lap: number | null
  d: number | null   // lap distance (m)
  thr: number        // 0..1 throttle
  brk: number        // 0..1 brake
  spd: number        // km/h
  gear: number
  steer: number      // -1..1
  rpm: number        // engine RPM
  drs: number        // 0 = closed, 1 = open
  // ERS (from CarStatus) — present only for sessions recorded by agents that
  // capture it; older sessions omit these and the analyser shows empty states.
  ers?: number       // store energy 0..1 (normalised by 4 MJ)
  erm?: number       // deploy mode: 0 none, 1 medium, 2 hotlap, 3 overtake
  // Per-tyre surface temperature (°C) and pressure (psi), FL/FR/RL/RR.
  tS?: [number, number, number, number]
  prs?: [number, number, number, number]
  // Per-tyre INNER (carcass) temperature (°C), FL/FR/RL/RR — same order as
  // tS. Parsed by the UDP layer but previously dropped before reaching the
  // collector; distinct signal from surface temp (short-term overheating
  // effects vs longer-term carcass heat build-up).
  tI?: [number, number, number, number]
}

export interface IncidentRecord {
  lap_number: number | null
  type: 'Penalty' | 'Collision' | 'Track Limits' | 'DNF' | 'Other'
  description: string
  time_lost: number | null
}

export interface DamageRecord {
  lap: number
  front_left_wing: number
  front_right_wing: number
  floor: number
  diffuser: number
  sidepod: number
  gearbox: number
  engine: number
}

// ── Race Grid Intelligence (Phase 1) records ────────────────────────────────
// All new/optional — SessionRecord's existing player-scoped fields above are
// untouched by any of this. Identity churn (a driver leaving, another
// joining the same car slot) is captured last-write-wins, matching how every
// existing per-car field in this file already behaves (e.g. player_team).

export interface ParticipantGridRecord {
  vehicle_index: number
  driver_name: string
  team_id: number
  race_number: number
  ai_controlled: boolean | null
  network_id: number | null
  nationality: number | null
  platform: number | null
}

export interface ClassificationGridRecord {
  vehicle_index: number
  position: number
  num_laps: number
  grid_position: number
  result_status: number
  best_lap_time_ms: number
  total_race_time_sec: number
  penalties_time_sec: number
}

export interface OpponentHistoryRecord {
  car_idx: number
  num_laps: number
  best_lap_number: number
  best_s1_lap: number
  best_s2_lap: number
  best_s3_lap: number
  laps: { lap_time_ms: number; sector_1_ms: number; sector_2_ms: number; sector_3_ms: number; valid: boolean }[]
}

export interface ParticipantIncidentRecord {
  vehicle_index: number
  lap_number: number | null
  type: 'Penalty' | 'Collision' | 'Track Limits' | 'Other'
  description: string
  time_lost: number | null
}

export interface GridPositionSnapshot {
  lap_number: number
  positions: { vehicle_index: number; car_position: number; driver_status: number; result_status: number }[]
}

// Race Context Intelligence: a bounded, all-car distance/gap snapshot sampled
// periodically throughout the session — distinct from GridPositionSnapshot
// above (which is classification-order only, once per PLAYER lap completion,
// and must stay unmodified since raceStory.ts already depends on its shape).
// `t` uses the same "ms since session start" epoch as TelemetrySample.t, so
// the two streams are natively joinable server-side.
/**
 * Where the driver races and how PitWall receives it. User-declared
 * configuration, not telemetry — F1's UDP feed does not identify the sending
 * platform, so this is reported honestly as a setting rather than inferred.
 */
export interface CaptureProfile {
  platform: 'PC' | 'PLAYSTATION' | 'XBOX' | 'UNKNOWN'
  captureMethod: 'PC_NATIVE' | 'CONSOLE_DESKTOP' | null
  platformOrigin?: 'detected' | 'user_selected' | 'inferred' | 'unknown'
  sourceDeviceId?: string | null
}

export interface ProximitySnapshot {
  t: number
  cars: {
    vehicle_index: number
    car_position: number
    lap_number: number
    total_distance: number | null
    gap_ahead_ms: number | null
  }[]
}

export interface SessionRecord {
  telemetry_gaps?: RecordedTelemetryGap[]
  track_state_events?: TrackStateEventRecord[]
  id: string
  source: 'udp_agent'
  game_version: GameVersion
  /** Which F1 25 car generation this session used — derived from the Session
   *  packet's formula field, not user-selected. 'unknown' when the signal
   *  was absent or unrecognised; never guessed. */
  vehicle_era: VehicleEra
  /** m_aiDifficulty (0-110), F1 25 only — see SessionPacket.aiDifficulty for
   *  why F1 23/24 always resolve to null. Never a guessed value. */
  ai_difficulty: number | null
  /** League Session Intelligence (MVP 1.1): capture provenance.
   *
   *  `platform` is where the driver RACED; `capture_method` is how PitWall
   *  received it — deliberately separate axes, because a console session is
   *  captured by a PC running this agent (PLAYSTATION + CONSOLE_DESKTOP).
   *
   *  Both are user-declared configuration, not telemetry: F1's UDP feed does
   *  not identify the sending platform for the player's own car, so this is
   *  reported honestly as a setting rather than inferred. Defaults keep every
   *  existing PC install behaving exactly as before. */
  platform: 'PC' | 'PLAYSTATION' | 'XBOX' | 'UNKNOWN'
  capture_method: 'PC_NATIVE' | 'CONSOLE_DESKTOP' | null
  platform_origin?: CaptureProfile['platformOrigin']
  source_device_id?: string | null
  track_id: number
  track_name: string
  session_type: string
  session_date: string
  total_laps: number
  weather_start: string
  weather_end: string
  track_temp: number
  air_temp: number
  player_team: string | null
  player_car_number: number | null
  finishing_position: number | null
  grid_position: number | null
  dnf: boolean
  dnf_reason: string | null
  abandoned: boolean
  overtakes: number
  fuel_load_start: number | null
  fuel_load_end: number | null
  // Raw F1 weather codes (0 clear … 5 storm) seen across the session, so the
  // server can classify Dry / Wet / Mixed from the actual range, not just the
  // value at session start (which is often still dry before rain arrives).
  weather_min_code: number
  weather_max_code: number
  setup_snapshot: SetupPacket | null
  laps: LapRecord[]
  stints: StintRecord[]
  damage_log: DamageRecord[]
  incidents: IncidentRecord[]
  telemetry_samples: TelemetrySample[]
  // Race Grid Intelligence (Phase 1) — all optional/additive, never read by
  // any existing consumer of this record.
  player_vehicle_index?: number
  // Session Intelligence Repair — the game's own session identifier
  // (m_sessionUID), already parsed into every packet header but never
  // persisted anywhere until now. Purely diagnostic/audit evidence for the
  // server's driver-identity resolver; set once per session, never clobbered.
  session_uid?: string
  participants_grid?: ParticipantGridRecord[]
  participants_classification?: ClassificationGridRecord[]
  opponent_history?: Record<number, OpponentHistoryRecord>
  participant_incidents?: ParticipantIncidentRecord[]
  grid_position_history?: GridPositionSnapshot[]
  // Race Context Intelligence — additive, see ProximitySnapshot's doc comment.
  proximity_snapshots?: ProximitySnapshot[]
}

type Wear = { fl: number; fr: number; rl: number; rr: number }

export interface RecordedTelemetryGap {
  start_received_at_ms: number
  end_received_at_ms: number | null
  reason: 'silence' | 'agent_restart'
  start_sample_time_ms: number
  end_sample_time_ms: number | null
}

export interface TrackStateEventRecord {
  state: 'green' | 'local_yellow' | 'red_flag' | 'safety_car' | 'virtual_safety_car' | 'formation' | 'unknown'
  lap_number: number | null
  observed_at_ms: number
  safety_car_status: number | null
  player_fia_flag: number | null
  source: 'session_status' | 'player_fia_flag' | 'unavailable'
}
export interface CollectorRecoveryState {
  record: SessionRecord
  sessionStartMs: number
  lastLapNumber: number
  lastLapMs: number
  lastPitStatus: number
  stintStartLap: number
}

const DAMAGE_LOG_INTERVAL = 5 // laps
// Downsample throttle/brake capture: at most one sample per this interval, and
// hard-cap the total so a long race can't produce an unbounded payload.
const SAMPLE_INTERVAL_MS = 200        // ~5 Hz — plenty for a throttle/brake trace
const MAX_SAMPLES = 6000              // ~20 min at 5 Hz; older ones are thinned
// Race Context Intelligence: all-car proximity is far larger per-sample (up to
// 22 cars) than the player's own single-car telemetry sample, so this is
// throttled much coarser — 2s is still frequent enough for hysteresis-debounced
// state classification, while keeping a long race's payload bounded.
const PROXIMITY_SAMPLE_INTERVAL_MS = 2000
const MAX_PROXIMITY_SNAPSHOTS = 2700  // ~90 min at 2s; same halving-thin fallback as MAX_SAMPLES
const MAX_TRACK_STATE_EVENTS = 1000

function resolveTrackState(safetyCarStatus: number | null, playerFiaFlag: number | null): Pick<TrackStateEventRecord, 'state' | 'source'> {
  if (safetyCarStatus === 1) return { state: 'safety_car', source: 'session_status' }
  if (safetyCarStatus === 2) return { state: 'virtual_safety_car', source: 'session_status' }
  if (safetyCarStatus === 3) return { state: 'formation', source: 'session_status' }
  if (playerFiaFlag === 4) return { state: 'red_flag', source: 'player_fia_flag' }
  if (playerFiaFlag === 3) return { state: 'local_yellow', source: 'player_fia_flag' }
  if (safetyCarStatus === 0 || playerFiaFlag === 0 || playerFiaFlag === 1) {
    return { state: 'green', source: safetyCarStatus === 0 ? 'session_status' : 'player_fia_flag' }
  }
  return { state: 'unknown', source: 'unavailable' }
}

export class SessionCollector {
  readonly record: SessionRecord

  // Live tracking state
  private lastLapNumber = 0
  private lastLapMs = 0
  private sector1Ms: number | null = null
  private sector2Ms: number | null = null
  private lastPitStatus = 0
  private currentWear: Wear | null = null
  private currentCompound: string | null = null
  private currentDamage: DamagePacket | null = null
  private prevWingDamage: { fl: number; fr: number; rear: number } | null = null
  private currentFuel: number | null = null
  private currentTyreAge: number | null = null
  // Latest ERS + tyre temp/pressure, folded into each telemetry sample.
  private currentErsStore: number | null = null   // 0..1
  private currentErsMode: number | null = null
  private currentTyreTemp: [number, number, number, number] | null = null
  private currentTyreInnerTemp: [number, number, number, number] | null = null
  private currentTyrePressure: [number, number, number, number] | null = null
  private currentCarPosition: number | null = null
  private lastLapEndPosition: number | null = null
  private currentLapDistance: number | null = null
  private sessionStartMs = Date.now()
  private lastSampleMs = 0
  private gapBeforeNextSample = false
  private lastProximitySampleMs = 0
  private safetyCarActive = false
  private safetyCarThisLap = false
  private currentSafetyCarStatus: number | null = null
  private currentPlayerFiaFlag: number | null = null
  private currentTrackState: TrackStateEventRecord['state'] | null = null
  private stintStartLap = 1
  private stintStartWear: Wear | null = null
  private lastDamageLogLap = 0
  // Race Grid Intelligence (Phase 1) — latest full-grid Lap Data snapshot,
  // used to build a per-lap-boundary position-history entry (see updateLap).
  private latestLapGrid: LapGridEntry[] | null = null

  constructor(gameVersion: GameVersion, session: SessionPacket, captureProfile?: CaptureProfile) {
    this.record = {
      id: randomUUID(),
      source: 'udp_agent',
      game_version: gameVersion,
      vehicle_era: deriveVehicleEra(session.formula),
      ai_difficulty: session.aiDifficulty,
      // Defaults preserve existing PC installs exactly: an agent that never
      // sets a profile keeps reporting PC / PC_NATIVE, which is what every
      // session before this change effectively was.
      platform: captureProfile?.platform ?? 'PC',
      capture_method: captureProfile ? captureProfile.captureMethod : 'PC_NATIVE',
      platform_origin: captureProfile?.platformOrigin,
      source_device_id: captureProfile?.sourceDeviceId ?? null,
      track_id: session.trackId,
      track_name: TRACK_NAMES[session.trackId] ?? `Track ${session.trackId}`,
      session_type: SESSION_TYPE_NAMES[session.sessionType] ?? 'unknown',
      session_date: new Date().toISOString(),
      total_laps: session.totalLaps,
      weather_start: WEATHER_NAMES[session.weather] ?? 'clear',
      weather_end: WEATHER_NAMES[session.weather] ?? 'clear',
      track_temp: session.trackTemperature,
      air_temp: session.airTemperature,
      player_team: null,
      player_car_number: null,
      finishing_position: null,
      grid_position: null,
      dnf: false,
      dnf_reason: null,
      abandoned: false,
      overtakes: 0,
      fuel_load_start: null,
      fuel_load_end: null,
      weather_min_code: session.weather,
      weather_max_code: session.weather,
      setup_snapshot: null,
      laps: [],
      stints: [],
      damage_log: [],
      incidents: [],
      telemetry_samples: [],
    }
    this.sessionStartMs = Date.now()
    this.currentSafetyCarStatus = session.safetyCarStatus
    this.recordTrackState()
    log.info(`Session started · ${this.record.track_name} · ${this.record.session_type} · ${session.totalLaps} laps`)
  }

  // ── Packet feeds ────────────────────────────────────────────────────────────

  updateSession(s: SessionPacket): void {
    this.record.weather_end = WEATHER_NAMES[s.weather] ?? this.record.weather_end
    if (s.weather < this.record.weather_min_code) this.record.weather_min_code = s.weather
    if (s.weather > this.record.weather_max_code) this.record.weather_max_code = s.weather
    this.record.total_laps = s.totalLaps || this.record.total_laps
    // Re-derive rather than overwrite unconditionally: formula shouldn't
    // change mid-session, but if a later packet resolves 'unknown' → a
    // known value, keep the improved read rather than freezing on the
    // constructor's first (possibly stale/corrupt) sample.
    if (this.record.vehicle_era === 'unknown') this.record.vehicle_era = deriveVehicleEra(s.formula)
    // Same don't-clobber-a-good-read rule as vehicle_era: AI difficulty is
    // set once from the first packet that resolves it, never overwritten by
    // a later null (which would happen for every non-F1-25 packet since
    // parseSession only ever resolves it for that one verified version).
    if (this.record.ai_difficulty == null && s.aiDifficulty != null) this.record.ai_difficulty = s.aiDifficulty
    this.currentSafetyCarStatus = s.safetyCarStatus
    this.recordTrackState()
    // Formation lap (3) is a distinct session state, not a Safety Car/VSC
    // period. Only explicit full-SC/VSC values neutralise a recorded lap.
    const scNow = s.safetyCarStatus === 1 || s.safetyCarStatus === 2
    if (scNow && !this.safetyCarActive) log.info(`Safety car status → ${s.safetyCarStatus}`)
    this.safetyCarActive = scNow
    if (scNow) this.safetyCarThisLap = true
  }

  updateParticipant(name: string, teamId: number, raceNumber: number): void {
    this.record.player_team = TEAM_NAMES[teamId] ?? `Team ${teamId}`
    this.record.player_car_number = raceNumber
    void name // driver name lives in the PitWall driver profile, not the session
  }

  // ── Race Grid Intelligence (Phase 1) feeds ──────────────────────────────
  // All additive — none of the methods above are modified or called from here.

  /**
   * Refreshed from every packet's header — self-correcting, no staleness
   * risk under normal play. But it's also unvalidated and unconditional: F1's
   * m_playerCarIndex can reflect a replay/spectate camera's car during a
   * post-finish-line window rather than the driver's own car, and this method
   * has no way to tell that apart from a genuine value. Session Intelligence
   * Repair Phase 1: log every actual CHANGE (not every packet — that would be
   * silent no-op noise) so real production data can confirm or rule out that
   * failure mode before the server-side resolver's tier weighting is
   * finalised. Dev-only by way of the logger's own `debug` level gate.
   */
  updatePlayerVehicleIndex(idx: number): void {
    if (idx !== this.record.player_vehicle_index) {
      log.debug(
        `player_vehicle_index changed ${this.record.player_vehicle_index ?? '(unset)'} → ${idx} ` +
        `· lap=${this.record.laps.length} ` +
        `· elapsed=${Math.round((Date.now() - this.sessionStartMs) / 1000)}s`,
      )
    }
    this.record.player_vehicle_index = idx
  }

  /** Set once from the first packet that carries it — never clobbered by a
   *  later read, matching the vehicle_era/ai_difficulty "don't clobber a good
   *  read" convention already used elsewhere in this class. */
  updateSessionUid(uid: string): void {
    if (!this.record.session_uid && uid) this.record.session_uid = uid
  }

  updateCaptureProfile(profile: CaptureProfile): void {
    if (profile.platform === 'UNKNOWN' && this.record.platform !== 'UNKNOWN') return
    this.record.platform = profile.platform
    this.record.capture_method = profile.captureMethod
    this.record.platform_origin = profile.platformOrigin
    this.record.source_device_id = profile.sourceDeviceId ?? null
  }

  recoveryState(): CollectorRecoveryState {
    return { record: structuredClone(this.record), sessionStartMs: this.sessionStartMs,
      lastLapNumber: this.lastLapNumber, lastLapMs: this.lastLapMs,
      lastPitStatus: this.lastPitStatus, stintStartLap: this.stintStartLap }
  }

  static restore(game: GameVersion, session: SessionPacket, state: CollectorRecoveryState): SessionCollector {
    const collector = new SessionCollector(game, session)
    Object.assign(collector.record, structuredClone(state.record))
    collector.sessionStartMs = state.sessionStartMs
    collector.lastLapNumber = state.lastLapNumber
    collector.lastLapMs = state.lastLapMs
    collector.lastPitStatus = state.lastPitStatus
    collector.stintStartLap = state.stintStartLap
    collector.currentSafetyCarStatus = session.safetyCarStatus
    const lastTrackState = collector.record.track_state_events?.at(-1)
    collector.currentPlayerFiaFlag = lastTrackState?.player_fia_flag ?? null
    collector.currentTrackState = lastTrackState?.state ?? resolveTrackState(collector.currentSafetyCarStatus, collector.currentPlayerFiaFlag).state
    collector.safetyCarActive = session.safetyCarStatus === 1 || session.safetyCarStatus === 2
    collector.gapBeforeNextSample = true
    return collector
  }

  openGap(lastAcceptedAt: number, reason: RecordedTelemetryGap['reason']): void {
    const gaps = this.record.telemetry_gaps ??= []
    if (gaps.at(-1)?.end_received_at_ms === null) return
    if (gaps.length < 1000) gaps.push({ start_received_at_ms: lastAcceptedAt, end_received_at_ms: null, reason,
      start_sample_time_ms: Math.max(0, lastAcceptedAt - this.sessionStartMs), end_sample_time_ms: null })
    this.gapBeforeNextSample = true
    this.sector1Ms = null; this.sector2Ms = null
    this.lastLapEndPosition = null
    this.currentWear = null; this.currentDamage = null; this.prevWingDamage = null
    this.currentFuel = null; this.currentTyreAge = null
    this.currentErsStore = null; this.currentErsMode = null
    this.currentTyreTemp = null; this.currentTyreInnerTemp = null; this.currentTyrePressure = null
    this.currentCarPosition = null; this.currentLapDistance = null
    this.latestLapGrid = null
  }

  closeGap(now: number): void {
    const gap = this.record.telemetry_gaps?.at(-1)
    if (!gap || gap.end_received_at_ms !== null || now <= gap.start_received_at_ms) return
    gap.end_received_at_ms = now
    gap.end_sample_time_ms = Math.max(0, now - this.sessionStartMs)
  }

  /** Full replace, last-write-wins per vehicle slot (matches updateParticipant's
   *  own last-write-wins behavior for the player's own car). */
  updateParticipantsGrid(entries: ParticipantGridEntry[]): void {
    this.record.participants_grid = entries.map((e) => ({
      vehicle_index: e.vehicleIndex,
      driver_name: e.driverName,
      team_id: e.teamId,
      race_number: e.raceNumber,
      ai_controlled: e.aiControlled,
      network_id: e.networkId,
      nationality: e.nationality,
      platform: e.platform,
    }))
  }

  /** Stores the latest full-grid Lap Data snapshot only — read by updateLap
   *  at each lap boundary to build a bounded grid_position_history entry. */
  updateLapDataGridSnapshot(entries: LapGridEntry[]): void {
    this.latestLapGrid = entries
  }

  /** Race Context Intelligence: buffered all-car proximity snapshot, throttled
   *  the same way updateTelemetry throttles the player's own samples — not a
   *  per-UDP-frame record, fires at most once per PROXIMITY_SAMPLE_INTERVAL_MS.
   *  Independent of updateLapDataGridSnapshot above (that one is an unthrottled
   *  "latest" pointer read only at player lap boundaries; this one is a real,
   *  bounded, appended history). */
  updateProximitySnapshot(entries: LapGridEntry[]): void {
    const now = Date.now()
    if (now - this.lastProximitySampleMs < PROXIMITY_SAMPLE_INTERVAL_MS) return
    this.lastProximitySampleMs = now
    if (!this.record.proximity_snapshots) this.record.proximity_snapshots = []
    this.record.proximity_snapshots.push({
      t: now - this.sessionStartMs,
      cars: entries.map((e) => ({
        vehicle_index: e.vehicleIndex,
        car_position: e.carPosition,
        lap_number: e.lapNumber,
        total_distance: e.totalDistance,
        gap_ahead_ms: e.gapAheadMs,
      })),
    })
    if (this.record.proximity_snapshots.length > MAX_PROXIMITY_SNAPSHOTS) {
      this.record.proximity_snapshots = this.record.proximity_snapshots.filter((_, i) => i % 2 === 0)
    }
  }

  /** Full replace — Final Classification broadcasts a complete snapshot. */
  applyClassificationGrid(entries: ClassificationGridEntry[]): void {
    this.record.participants_classification = entries.map((e) => ({
      vehicle_index: e.vehicleIndex,
      position: e.position,
      num_laps: e.numLaps,
      grid_position: e.gridPosition,
      result_status: e.resultStatus,
      best_lap_time_ms: e.bestLapTimeMs,
      total_race_time_sec: e.totalRaceTimeSec,
      penalties_time_sec: e.penaltiesTimeSec,
    }))
  }

  /** Full replace per carIdx key — each car's Session History broadcast is
   *  itself cumulative, so replace-not-merge is correct and simplest. */
  applyHistoryGrid(pkt: HistoryGridPacket): void {
    if (!this.record.opponent_history) this.record.opponent_history = {}
    this.record.opponent_history[pkt.carIdx] = {
      car_idx: pkt.carIdx,
      num_laps: pkt.numLaps,
      best_lap_number: pkt.bestLapNumber,
      best_s1_lap: pkt.bestS1Lap,
      best_s2_lap: pkt.bestS2Lap,
      best_s3_lap: pkt.bestS3Lap,
      laps: pkt.laps.map((l) => ({
        lap_time_ms: l.lapTimeMs, sector_1_ms: l.sector1Ms, sector_2_ms: l.sector2Ms,
        sector_3_ms: l.sector3Ms, valid: l.valid,
      })),
    }
  }

  /** Penalty/collision events for ANY car, independent of the player-only
   *  recordPenalty/recordCollision above (which stay unchanged and keep
   *  feeding record.incidents for backward compatibility). */
  recordAnyCarPenalty(evt: EventPacket): void {
    if (evt.vehicleIdx == null) return
    const ptype = PENALTY_TYPE_NAMES[evt.penaltyType ?? -1] ?? 'Penalty'
    const infr = INFRINGEMENT_NAMES[evt.infringementType ?? -1] ?? 'infringement'
    const lap = evt.lapNum ?? this.currentLap
    const isWarning = evt.penaltyType === 5
    const isTrackLimits = (evt.infringementType ?? -1) >= 25 && (evt.infringementType ?? -1) <= 29
    const time = evt.penaltyTime && evt.penaltyTime > 0 && evt.penaltyType === 4 ? evt.penaltyTime : null
    const type = isTrackLimits ? 'Track Limits' : 'Penalty'
    const desc = isWarning ? `Warning — ${infr}` : `${ptype} — ${infr}${time ? ` (+${time}s)` : ''}`
    this.addParticipantIncident(evt.vehicleIdx, type, desc, lap, time)
  }

  recordAnyCarCollision(evt: EventPacket): void {
    const lap = this.currentLap
    for (const vehicleIndex of [evt.vehicleIdx, evt.otherVehicleIdx]) {
      if (vehicleIndex == null) continue
      this.addParticipantIncident(vehicleIndex, 'Collision', 'Collision with another car', lap)
    }
  }

  private addParticipantIncident(
    vehicleIndex: number, type: ParticipantIncidentRecord['type'],
    description: string, lapNumber: number | null, timeLost: number | null = null,
  ): void {
    if (!this.record.participant_incidents) this.record.participant_incidents = []
    const dup = this.record.participant_incidents.some(
      (i) => i.vehicle_index === vehicleIndex && i.lap_number === lapNumber && i.description === description,
    )
    if (dup) return
    this.record.participant_incidents.push({ vehicle_index: vehicleIndex, lap_number: lapNumber, type, description, time_lost: timeLost })
  }

  updateSetup(setup: SetupPacket): void {
    this.record.setup_snapshot = setup
  }

  updateStatus(s: StatusPacket): void {
    this.currentPlayerFiaFlag = s.vehicleFiaFlags
    this.recordTrackState()
    if (this.record.fuel_load_start === null && s.fuelInTank > 0) {
      this.record.fuel_load_start = round1(s.fuelInTank)
    }
    if (s.fuelInTank > 0) {
      this.record.fuel_load_end = round1(s.fuelInTank)
      this.currentFuel = s.fuelInTank
    }
    if (s.tyresAgeLaps != null) this.currentTyreAge = s.tyresAgeLaps
    const compound = VISUAL_COMPOUND_NAMES[s.visualTyreCompound]
    if (compound && compound !== this.currentCompound) {
      this.currentCompound = compound
    }
    // ERS: normalise store energy against the 4 MJ battery cap.
    if (s.ersStoreEnergy != null) this.currentErsStore = Math.min(1, Math.max(0, s.ersStoreEnergy / 4_000_000))
    if (s.ersDeployMode != null) this.currentErsMode = s.ersDeployMode
  }

  private recordTrackState(): void {
    const resolved = resolveTrackState(this.currentSafetyCarStatus, this.currentPlayerFiaFlag)
    if (resolved.state === this.currentTrackState) return
    this.currentTrackState = resolved.state
    const events = this.record.track_state_events ??= []
    if (events.length >= MAX_TRACK_STATE_EVENTS) return
    events.push({
      ...resolved,
      lap_number: this.currentLap || null,
      observed_at_ms: Math.max(0, Date.now() - this.sessionStartMs),
      safety_car_status: this.currentSafetyCarStatus,
      player_fia_flag: this.currentPlayerFiaFlag,
    })
  }

  updateDamage(d: DamagePacket): void {
    this.currentWear = d.tyreWear
    this.currentDamage = d
    if (this.stintStartWear === null) this.stintStartWear = { ...d.tyreWear }

    // Detect a meaningful jump in wing/body damage → log as an incident.
    // (A ≥15-point increase between packets almost always means contact.)
    const now = { fl: d.frontLeftWing, fr: d.frontRightWing, rear: d.rearWing }
    if (this.prevWingDamage) {
      const jumps: string[] = []
      if (now.fl - this.prevWingDamage.fl >= 15) jumps.push(`front-left wing ${now.fl}%`)
      if (now.fr - this.prevWingDamage.fr >= 15) jumps.push(`front-right wing ${now.fr}%`)
      if (now.rear - this.prevWingDamage.rear >= 15) jumps.push(`rear wing ${now.rear}%`)
      if (jumps.length) {
        this.addIncident('Other', `Damage sustained: ${jumps.join(', ')}`, this.currentLap)
      }
    }
    this.prevWingDamage = now
  }

  /** Record a penalty event (already filtered to the player by the lifecycle). */
  recordPenalty(evt: EventPacket): void {
    const ptype = PENALTY_TYPE_NAMES[evt.penaltyType ?? -1] ?? 'Penalty'
    const infr = INFRINGEMENT_NAMES[evt.infringementType ?? -1] ?? 'infringement'
    const lap = evt.lapNum ?? this.currentLap
    const isWarning = evt.penaltyType === 5
    const isTrackLimits = (evt.infringementType ?? -1) >= 25 && (evt.infringementType ?? -1) <= 29
    const time = evt.penaltyTime && evt.penaltyTime > 0 && evt.penaltyType === 4 ? evt.penaltyTime : null
    const type = isTrackLimits ? 'Track Limits' : 'Penalty'
    const desc = isWarning
      ? `Warning — ${infr}`
      : `${ptype} — ${infr}${time ? ` (+${time}s)` : ''}`
    this.addIncident(type, desc, lap, time)
    log.info(`Incident · lap ${lap} · ${desc}`)
  }

  /** Record a collision event involving the player. */
  recordCollision(): void {
    const lap = this.currentLap
    this.addIncident('Collision', 'Collision with another car', lap)
    log.info(`Incident · lap ${lap} · collision`)
  }

  private addIncident(
    type: IncidentRecord['type'], description: string,
    lapNumber: number | null, timeLost: number | null = null,
  ): void {
    // De-dupe identical incidents on the same lap (F1 can repeat event packets)
    const dup = this.record.incidents.some(
      (i) => i.lap_number === lapNumber && i.description === description,
    )
    if (dup) return
    this.record.incidents.push({ lap_number: lapNumber, type, description, time_lost: timeLost })
  }

  /** Capture a throttle/brake telemetry sample (downsampled to ~5 Hz). */
  updateTelemetry(t: CarTelemetryPacket): void {
    // Keep the latest tyre temps/pressures for the next sample + lap aggregation.
    if (t.tyreSurfaceTemp) {
      this.currentTyreTemp = [t.tyreSurfaceTemp.fl, t.tyreSurfaceTemp.fr, t.tyreSurfaceTemp.rl, t.tyreSurfaceTemp.rr]
    }
    if (t.tyreInnerTemp) {
      this.currentTyreInnerTemp = [t.tyreInnerTemp.fl, t.tyreInnerTemp.fr, t.tyreInnerTemp.rl, t.tyreInnerTemp.rr]
    }
    if (t.tyrePressure) {
      this.currentTyrePressure = [t.tyrePressure.fl, t.tyrePressure.fr, t.tyrePressure.rl, t.tyrePressure.rr]
    }
    const now = Date.now()
    if (now - this.lastSampleMs < SAMPLE_INTERVAL_MS) return
    this.lastSampleMs = now
    const samples = this.record.telemetry_samples
    const sample: TelemetrySample = {
      ...(this.gapBeforeNextSample ? { gap_before: true } : {}),
      t: now - this.sessionStartMs,
      lap: this.lastLapNumber || null,
      d: this.currentLapDistance,
      thr: Math.round(t.throttle * 1000) / 1000,
      brk: Math.round(t.brake * 1000) / 1000,
      spd: t.speed,
      gear: t.gear,
      steer: Math.round(t.steer * 1000) / 1000,
      rpm: t.rpm,
      drs: t.drs,
    }
    if (this.currentErsStore != null) sample.ers = Math.round(this.currentErsStore * 1000) / 1000
    if (this.currentErsMode != null) sample.erm = this.currentErsMode
    if (this.currentTyreTemp) sample.tS = this.currentTyreTemp
    if (this.currentTyrePressure) sample.prs = this.currentTyrePressure
    samples.push(sample)
    this.gapBeforeNextSample = false
    // Hard cap: if we hit the ceiling, thin by dropping every other sample so
    // the trace still spans the whole session rather than truncating it.
    if (samples.length > MAX_SAMPLES) {
      let pendingGap = false
      this.record.telemetry_samples = samples.filter((sample, i) => {
        pendingGap ||= sample.gap_before === true
        if (i % 2 !== 0) return false
        if (pendingGap) sample.gap_before = true
        pendingGap = false
        return true
      })
      this.gapBeforeNextSample = pendingGap
    }
  }

  /** Feed a lap packet; returns true when a lap just completed. */
  updateLap(lap: LapPacket): boolean {
    // Grid position — first non-zero value
    if (this.record.grid_position === null && lap.gridPosition > 0) {
      this.record.grid_position = lap.gridPosition
    }
    if (lap.carPosition > 0) {
      this.record.finishing_position = lap.carPosition
      this.currentCarPosition = lap.carPosition
    }
    if (lap.lapDistance >= 0) this.currentLapDistance = lap.lapDistance

    // Sector capture (first stable non-zero values within the lap)
    if (this.sector1Ms === null && lap.sector1Ms > 0) this.sector1Ms = lap.sector1Ms
    if (this.sector2Ms === null && lap.sector2Ms > 0 && this.sector1Ms !== null) this.sector2Ms = lap.sector2Ms

    // Pit-stop transitions
    if (lap.pitStatus > 0 && this.lastPitStatus === 0) {
      log.info(`Pit entry · lap ${lap.lapNumber} · removing ${this.currentCompound ?? '?'} · wear ${wearStr(this.currentWear)}`)
      this.closeStint(lap.lapNumber)
    } else if (lap.pitStatus === 0 && this.lastPitStatus > 0) {
      log.info(`Pit exit · lap ${lap.lapNumber} · fitted ${this.currentCompound ?? '?'}`)
      this.stintStartLap = lap.lapNumber
      this.stintStartWear = this.currentWear ? { ...this.currentWear } : null
    }
    const pitThisLap = lap.pitStatus > 0 || this.lastPitStatus > 0
    this.lastPitStatus = lap.pitStatus

    // First lap packet of the session: baseline only — the game can carry a
    // stale lastLapTime over from a previous session, which would otherwise
    // record a phantom lap 0.
    if (this.lastLapNumber === 0) {
      this.lastLapNumber = lap.lapNumber
      this.lastLapMs = lap.lastLapMs
      return false
    }

    // Lap completion: lap number incremented with a fresh lastLapTime
    let completed = false
    if (lap.lapNumber > this.lastLapNumber && lap.lastLapMs > 0 && lap.lastLapMs !== this.lastLapMs) {
      const s1 = this.sector1Ms ?? 0
      const s2 = this.sector2Ms ?? 0
      const s3 = s1 && s2 ? Math.max(0, lap.lastLapMs - s1 - s2) : 0

      const rec: LapRecord = {
        lap_number: lap.lapNumber - 1 || 1,
        lap_time_ms: lap.lastLapMs,
        sector_1_ms: s1,
        sector_2_ms: s2,
        sector_3_ms: s3,
        lap_valid: !lap.lapInvalid,
        tyre_wear_fl: this.currentWear?.fl ?? null,
        tyre_wear_fr: this.currentWear?.fr ?? null,
        tyre_wear_rl: this.currentWear?.rl ?? null,
        tyre_wear_rr: this.currentWear?.rr ?? null,
        tyre_compound: this.currentCompound,
        tyre_age: this.currentTyreAge,
        fuel_load: this.currentFuel != null ? round1(this.currentFuel) : null,
        car_position: this.currentCarPosition,
        pit_this_lap: pitThisLap,
        safety_car_this_lap: this.safetyCarThisLap,
      }
      this.record.laps.push(rec)
      log.info(`Lap ${rec.lap_number} complete · ${fmtLapTime(rec.lap_time_ms)} · S1 ${fmtSector(s1)} S2 ${fmtSector(s2)} S3 ${fmtSector(s3)}`)

      // Overtake counting — positions gained vs the end of the previous lap
      if (this.lastLapEndPosition !== null && this.currentCarPosition !== null) {
        const gained = this.lastLapEndPosition - this.currentCarPosition
        if (gained > 0) this.record.overtakes += gained
      }
      this.lastLapEndPosition = this.currentCarPosition

      // Periodic damage snapshot
      if (this.currentDamage && rec.lap_number - this.lastDamageLogLap >= DAMAGE_LOG_INTERVAL) {
        this.lastDamageLogLap = rec.lap_number
        const d = this.currentDamage
        this.record.damage_log.push({
          lap: rec.lap_number,
          front_left_wing: d.frontLeftWing,
          front_right_wing: d.frontRightWing,
          floor: d.floor,
          diffuser: d.diffuser,
          sidepod: d.sidepod,
          gearbox: d.gearbox,
          engine: d.engine,
        })
      }

      this.lastLapNumber = lap.lapNumber
      this.lastLapMs = lap.lastLapMs
      this.sector1Ms = null
      this.sector2Ms = null
      this.safetyCarThisLap = this.safetyCarActive // carries over if SC still out
      completed = true

      // Race Grid Intelligence (additive): snapshot the grid's positions at
      // this lap boundary from the latest full-grid Lap Data packet seen —
      // bounded to roughly one entry per player lap, same order of
      // magnitude as record.laps.
      if (this.latestLapGrid) {
        if (!this.record.grid_position_history) this.record.grid_position_history = []
        this.record.grid_position_history.push({
          lap_number: rec.lap_number,
          positions: this.latestLapGrid.map((g) => ({
            vehicle_index: g.vehicleIndex,
            car_position: g.carPosition,
            driver_status: g.driverStatus,
            result_status: g.resultStatus,
          })),
        })
      }
    }

    // DNF detection from result status (4 = dnf, 5 = dsq, 6 = not classified, 7 = retired)
    if (lap.resultStatus >= 4 && lap.resultStatus <= 7) {
      this.record.dnf = true
      this.record.dnf_reason = ({ 4: 'dnf', 5: 'disqualified', 6: 'not_classified', 7: 'retired' } as Record<number, string>)[lap.resultStatus] ?? 'dnf'
    }

    return completed
  }

  applyClassification(c: ClassificationPacket): void {
    this.record.finishing_position = c.position || this.record.finishing_position
    this.record.grid_position = c.gridPosition || this.record.grid_position
    if (c.resultStatus >= 4 && c.resultStatus <= 7) this.record.dnf = true
  }

  /** Backfill the per-lap sector breakdown from the session-history packet. */
  applyHistory(h: HistoryPacket): void {
    for (let i = 0; i < h.laps.length; i++) {
      const src = h.laps[i]
      if (src.lapTimeMs <= 0) continue
      const existing = this.record.laps.find((l) => l.lap_number === i + 1)
      if (existing) {
        // Prefer the history packet's sector data — it's authoritative
        existing.lap_time_ms = src.lapTimeMs
        existing.sector_1_ms = src.sector1Ms
        existing.sector_2_ms = src.sector2Ms
        existing.sector_3_ms = src.sector3Ms
        existing.lap_valid = src.valid
      }
    }
  }

  get currentLap(): number {
    return this.lastLapNumber
  }

  private closeStint(endLap: number): void {
    this.record.stints.push({
      stint_number: this.record.stints.length + 1,
      compound: this.currentCompound,
      start_lap: this.stintStartLap,
      end_lap: endLap,
      tyre_wear_start_fl: this.stintStartWear?.fl ?? null,
      tyre_wear_start_fr: this.stintStartWear?.fr ?? null,
      tyre_wear_start_rl: this.stintStartWear?.rl ?? null,
      tyre_wear_start_rr: this.stintStartWear?.rr ?? null,
      tyre_wear_end_fl: this.currentWear?.fl ?? null,
      tyre_wear_end_fr: this.currentWear?.fr ?? null,
      tyre_wear_end_rl: this.currentWear?.rl ?? null,
      tyre_wear_end_rr: this.currentWear?.rr ?? null,
    })
  }

  /** Finalise the record for sync. */
  finalise(abandoned: boolean): SessionRecord {
    // Close the open stint at the last completed lap
    if (this.lastLapNumber >= this.stintStartLap) this.closeStint(this.lastLapNumber)
    this.record.abandoned = abandoned
    log.info(`Session ended · ${this.record.laps.length} laps · ` +
      `${this.record.finishing_position ? `P${this.record.finishing_position} finish` : 'no classification'}` +
      (abandoned ? ' · ABANDONED' : ''))
    return this.record
  }
}

function round1(n: number): number { return Math.round(n * 10) / 10 }
function wearStr(w: Wear | null): string {
  return w ? `FL ${w.fl}% FR ${w.fr}% RL ${w.rl}% RR ${w.rr}%` : '—'
}
