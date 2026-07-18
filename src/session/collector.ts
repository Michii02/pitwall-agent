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

export interface SessionRecord {
  id: string
  source: 'udp_agent'
  game_version: GameVersion
  /** Which F1 25 car generation this session used — derived from the Session
   *  packet's formula field, not user-selected. 'unknown' when the signal
   *  was absent or unrecognised; never guessed. */
  vehicle_era: VehicleEra
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
}

type Wear = { fl: number; fr: number; rl: number; rr: number }

const DAMAGE_LOG_INTERVAL = 5 // laps
// Downsample throttle/brake capture: at most one sample per this interval, and
// hard-cap the total so a long race can't produce an unbounded payload.
const SAMPLE_INTERVAL_MS = 200        // ~5 Hz — plenty for a throttle/brake trace
const MAX_SAMPLES = 6000              // ~20 min at 5 Hz; older ones are thinned

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
  private currentTyrePressure: [number, number, number, number] | null = null
  private currentCarPosition: number | null = null
  private lastLapEndPosition: number | null = null
  private currentLapDistance: number | null = null
  private sessionStartMs = Date.now()
  private lastSampleMs = 0
  private safetyCarActive = false
  private safetyCarThisLap = false
  private stintStartLap = 1
  private stintStartWear: Wear | null = null
  private lastDamageLogLap = 0

  constructor(gameVersion: GameVersion, session: SessionPacket) {
    this.record = {
      id: randomUUID(),
      source: 'udp_agent',
      game_version: gameVersion,
      vehicle_era: deriveVehicleEra(session.formula),
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
    const scNow = s.safetyCarStatus > 0
    if (scNow && !this.safetyCarActive) log.info(`Safety car status → ${s.safetyCarStatus}`)
    this.safetyCarActive = scNow
    if (scNow) this.safetyCarThisLap = true
  }

  updateParticipant(name: string, teamId: number, raceNumber: number): void {
    this.record.player_team = TEAM_NAMES[teamId] ?? `Team ${teamId}`
    this.record.player_car_number = raceNumber
    void name // driver name lives in the PitWall driver profile, not the session
  }

  updateSetup(setup: SetupPacket): void {
    this.record.setup_snapshot = setup
  }

  updateStatus(s: StatusPacket): void {
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
    if (t.tyrePressure) {
      this.currentTyrePressure = [t.tyrePressure.fl, t.tyrePressure.fr, t.tyrePressure.rl, t.tyrePressure.rr]
    }
    const now = Date.now()
    if (now - this.lastSampleMs < SAMPLE_INTERVAL_MS) return
    this.lastSampleMs = now
    const samples = this.record.telemetry_samples
    const sample: TelemetrySample = {
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
    // Hard cap: if we hit the ceiling, thin by dropping every other sample so
    // the trace still spans the whole session rather than truncating it.
    if (samples.length > MAX_SAMPLES) {
      this.record.telemetry_samples = samples.filter((_, i) => i % 2 === 0)
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
        lap_number: this.lastLapNumber || lap.lapNumber - 1 || 1,
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
