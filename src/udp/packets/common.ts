/**
 * Shared packet types, lookup tables, and per-version struct layout constants.
 *
 * The F1 23 / 24 / 25 UDP specs share a 29-byte header and near-identical
 * field layouts for the packets PitWall consumes; what changes between years
 * is mostly per-car struct SIZES (which shift the player-car offset) plus a
 * few appended fields. Each version module exports a VersionLayout with the
 * sizes for that year; field offsets within the structs we read are stable.
 */

// ── Header (identical across F1 23/24/25 — 29 bytes) ─────────────────────────
export const HEADER_SIZE = 29
export const OFF_PACKET_FORMAT = 0 // uint16 — 2023 | 2024 | 2025
export const OFF_PACKET_ID = 6 // uint8
export const OFF_SESSION_UID_LO = 7 // uint64 LE (read as two uint32s)
export const OFF_PLAYER_CAR_INDEX = 27 // uint8

// ── Packet IDs ────────────────────────────────────────────────────────────────
export const PACKET = {
  MOTION: 0,
  SESSION: 1,
  LAP_DATA: 2,
  EVENT: 3,
  PARTICIPANTS: 4,
  CAR_SETUPS: 5,
  CAR_TELEMETRY: 6,
  CAR_STATUS: 7,
  FINAL_CLASSIFICATION: 8,
  LOBBY_INFO: 9,
  CAR_DAMAGE: 10,
  SESSION_HISTORY: 11,
  TYRE_SETS: 12,
  // F1 25: 2026 Season Pack only (packetFormat 2026). Recognised so
  // parsePacket() can log it distinctly instead of an "unrecognised packet
  // ID" warning — NOT parsed yet, see parser.ts.
  CAR_TELEMETRY_2: 16,
} as const

export type GameVersion = 'f1_2023' | 'f1_2024' | 'f1_2025'

/** Per-version struct sizes / layout switches. */
export interface VersionLayout {
  gameVersion: GameVersion
  packetFormat: number
  lapDataSize: number
  carSetupSize: number
  /** Byte offset of the engine-braking field inside car setup, or null if absent (pre-F1 25). */
  setupHasEngineBraking: boolean
  carStatusSize: number
  carDamageSize: number
  participantSize: number
  finalClassificationSize: number
  /** Lap-history entry size inside the session-history packet. */
  lapHistorySize: number
  /** Whether lap-history sector times carry separate minutes bytes (F1 24+). */
  historyHasMinutes: boolean
  hasTyreSets: boolean
  tyreSetSize: number
}

// ── Parsed packet shapes ──────────────────────────────────────────────────────

export interface ParsedHeader {
  packetFormat: number
  packetId: number
  sessionUid: string
  playerCarIndex: number
}

export interface SessionPacket {
  kind: 'session'
  trackId: number
  /** m_formula — ruleset/regulation identifier. 13 = F1 26 (2026 Season
   *  Pack); 0/1/2/3/4/6/8/9 are pre-2026 values (F1 Modern/Classic/F2/
   *  Generic/Beta/Esports/F1 World/Elimination). Used by vehicleEra.ts to
   *  detect which car generation this session used. */
  formula: number
  sessionType: number
  totalLaps: number
  weather: number
  trackTemperature: number
  airTemperature: number
  safetyCarStatus: number // 0 none, 1 full, 2 virtual, 3 formation
  sessionTimeLeft: number
  /** m_aiDifficulty (0-110). Sits after the variable-length weather-forecast
   *  sample array, so its byte offset depends on that array's fixed size,
   *  which differs by game version. Only independently verified for F1 25
   *  (offset cross-checked against this file's own already-working
   *  safetyCarStatus offset via the official spec's cumulative field sizes)
   *  — null for F1 23/24 and for online/network sessions where the game
   *  may not populate it meaningfully. Never guessed for unverified
   *  versions; see parseSession in parser.ts. */
  aiDifficulty: number | null
}

export interface LapPacket {
  kind: 'lap'
  lapNumber: number
  lastLapMs: number
  currentLapMs: number
  sector1Ms: number
  sector2Ms: number
  lapInvalid: boolean
  pitStatus: number // 0 none, 1 pitting, 2 in pit area
  driverStatus: number // 0 garage, 1 flying, 2 in lap, 3 out lap, 4 on track
  resultStatus: number // 0 invalid, 1 inactive, 2 active, 3 finished, 4 dnf …
  carPosition: number
  gridPosition: number
  numPitStops: number
  sector: number // 0=S1, 1=S2, 2=S3 — which sector the car is currently in
  lapDistance: number // metres travelled around the current lap
  /** Race Grid Intelligence: every car in this packet — see
   *  parseLapDataGrid in parser.ts. Optional/additive. */
  grid?: LapGridEntry[]
}

/** One car's Lap Data-packet fields, for the Race Grid Intelligence
 *  multi-car capture (Phase 1) — same offsets as the already-proven
 *  single-car parseLap, just applied per vehicle slot. */
export interface LapGridEntry {
  vehicleIndex: number
  lastLapMs: number
  currentLapMs: number
  sector1Ms: number
  sector2Ms: number
  carPosition: number
  lapNumber: number
  pitStatus: number
  numPitStops: number
  lapInvalid: boolean
  driverStatus: number
  resultStatus: number
  gridPosition: number
}

export interface EventPacket {
  kind: 'event'
  code: string // 'SSTA' | 'SEND' | 'FLAP' | 'PENA' | 'RCWN' | 'COLL' | …
  // Penalty detail (code === 'PENA')
  penaltyType?: number
  infringementType?: number
  vehicleIdx?: number
  otherVehicleIdx?: number
  penaltyTime?: number
  lapNum?: number
  // Collision detail (code === 'COLL')
}

export interface ParticipantPacket {
  kind: 'participant'
  driverName: string
  teamId: number
  raceNumber: number
  /** Race Grid Intelligence: every car in this packet, not just the player's
   *  own slot — see parseParticipantsGrid in parser.ts. Optional/additive;
   *  existing consumers of driverName/teamId/raceNumber are unaffected. */
  grid?: ParticipantGridEntry[]
}

/** One car's Participants-packet data, for the Race Grid Intelligence
 *  multi-car capture (Phase 1). aiControlled/networkId/nationality are
 *  independently verified for F1 25 only (cross-checked against
 *  MacManley/f1-25-udp's published struct, corroborating this file's
 *  already-proven teamId@3/raceNumber@5 offsets) — null for F1 23/24.
 *  platform is likewise F1-25-only-verified (offset 43); null elsewhere. */
export interface ParticipantGridEntry {
  vehicleIndex: number
  driverName: string
  teamId: number
  raceNumber: number
  aiControlled: boolean | null
  networkId: number | null
  nationality: number | null
  platform: number | null
}

export interface SetupPacket {
  kind: 'setup'
  front_wing: number
  rear_wing: number
  on_throttle_diff: number
  off_throttle_diff: number
  front_camber: number
  rear_camber: number
  front_toe: number
  rear_toe: number
  front_suspension: number
  rear_suspension: number
  front_arb: number
  rear_arb: number
  front_ride_height: number
  rear_ride_height: number
  brake_pressure: number
  front_brake_bias: number
  front_tyre_pressure: number
  rear_tyre_pressure: number
  ballast: number
  fuel_load: number
}

export interface CarTelemetryPacket {
  kind: 'carTelemetry'
  speed: number
  throttle: number
  brake: number
  steer: number
  gear: number
  rpm: number
  drs: number
  // Per-tyre surface/inner temperatures (°C) and pressures (psi), FL/FR/RL/RR.
  tyreSurfaceTemp: { fl: number; fr: number; rl: number; rr: number }
  tyreInnerTemp: { fl: number; fr: number; rl: number; rr: number }
  tyrePressure: { fl: number; fr: number; rl: number; rr: number }
}

export interface StatusPacket {
  kind: 'status'
  fuelInTank: number
  fuelMix: number
  visualTyreCompound: number
  actualTyreCompound: number
  tyresAgeLaps: number
  ersStoreEnergy: number        // Joules (max ~4,000,000 = 4 MJ)
  ersDeployMode: number         // 0 none, 1 medium, 2 hotlap, 3 overtake
  ersDeployedThisLap: number    // Joules deployed this lap
  ersHarvestedThisLap: number   // Joules harvested this lap (MGU-K + MGU-H)
  vehicleFiaFlags: number
}

export interface DamagePacket {
  kind: 'damage'
  tyreWear: { fl: number; fr: number; rl: number; rr: number }
  frontLeftWing: number
  frontRightWing: number
  rearWing: number
  floor: number
  diffuser: number
  sidepod: number
  gearbox: number
  engine: number
}

export interface ClassificationPacket {
  kind: 'classification'
  position: number
  numLaps: number
  gridPosition: number
  resultStatus: number
  bestLapTimeMs: number
  totalRaceTimeSec: number
  penaltiesTimeSec: number
  /** Race Grid Intelligence: every car in this packet — see
   *  parseClassificationGrid in parser.ts. Optional/additive. */
  grid?: ClassificationGridEntry[]
}

/** One car's Final Classification-packet fields, for the Race Grid
 *  Intelligence multi-car capture (Phase 1). Unlike the single-car
 *  parseClassification above, this applies the F1-25-only +1 byte shift
 *  (m_resultReason, inserted right after m_resultStatus — independently
 *  confirmed against MacManley/f1-25-udp's published struct, and matches
 *  finalClassificationSize growing 45→46 bytes exactly for F1 25) so
 *  bestLapTimeMs/totalRaceTimeSec/penaltiesTimeSec read correctly for F1 25.
 *  position/numLaps/gridPosition/resultStatus are unaffected (they sit
 *  before the inserted byte) — see parseClassificationGrid for detail. */
export interface ClassificationGridEntry {
  vehicleIndex: number
  position: number
  numLaps: number
  gridPosition: number
  resultStatus: number
  bestLapTimeMs: number
  totalRaceTimeSec: number
  penaltiesTimeSec: number
}

export interface HistoryLapEntry {
  lapTimeMs: number
  sector1Ms: number
  sector2Ms: number
  sector3Ms: number
  valid: boolean
}

export interface HistoryPacket {
  kind: 'history'
  carIdx: number
  numLaps: number
  bestLapNumber: number
  bestS1Lap: number
  bestS2Lap: number
  bestS3Lap: number
  laps: HistoryLapEntry[]
}

/** Race Grid Intelligence: Session History for a car OTHER than the player
 *  (the single-car 'history' kind above already covers the player's own —
 *  this is a distinct kind, not a modification of it, emitted only for the
 *  previously-always-discarded non-player packets). Same fields/parsing as
 *  HistoryPacket, see parseHistoryAnyCar in parser.ts. */
export interface HistoryGridPacket {
  kind: 'historyGrid'
  carIdx: number
  numLaps: number
  bestLapNumber: number
  bestS1Lap: number
  bestS2Lap: number
  bestS3Lap: number
  laps: HistoryLapEntry[]
}

export interface TyreSetsPacket {
  kind: 'tyreSets'
  fittedIdx: number
  sets: { compound: number; wear: number; available: boolean; fitted: boolean }[]
}

export type ParsedPacket =
  | SessionPacket | LapPacket | EventPacket | ParticipantPacket | SetupPacket
  | StatusPacket | DamagePacket | ClassificationPacket | HistoryPacket | TyreSetsPacket
  | CarTelemetryPacket | HistoryGridPacket

// ── Lookup tables ─────────────────────────────────────────────────────────────

export const TRACK_NAMES: Record<number, string> = {
  0: 'Melbourne (Australian GP)',
  1: 'Paul Ricard (French GP)',
  2: 'Shanghai (Chinese GP)',
  3: 'Sakhir (Bahrain GP)',
  4: 'Catalunya (Spanish GP)',
  5: 'Monaco',
  6: 'Montreal (Canadian GP)',
  7: 'Silverstone (British GP)',
  8: 'Hockenheim (German GP)',
  9: 'Hungaroring (Hungarian GP)',
  10: 'Spa (Belgian GP)',
  11: 'Monza (Italian GP)',
  12: 'Singapore',
  13: 'Suzuka (Japanese GP)',
  14: 'Abu Dhabi',
  15: 'Texas (US GP / COTA)',
  16: 'Brazil (São Paulo GP)',
  17: 'Austria (Red Bull Ring)',
  18: 'Sochi (Russian GP)',
  19: 'Mexico City',
  20: 'Baku (Azerbaijan GP)',
  21: 'Sakhir Short',
  22: 'Silverstone Short',
  23: 'Texas Short',
  24: 'Suzuka Short',
  25: 'Hanoi (Vietnamese GP)',
  26: 'Zandvoort (Dutch GP)',
  27: 'Imola (Emilia Romagna GP)',
  28: 'Portimão (Portuguese GP)',
  29: 'Jeddah (Saudi Arabian GP)',
  30: 'Miami',
  31: 'Las Vegas',
  32: 'Losail (Qatar GP)',
}

export const TEAM_NAMES: Record<number, string> = {
  // F1 25 season grid (also valid IDs for 23/24 where they overlap)
  0: 'Mercedes',
  1: 'Ferrari',
  2: 'Red Bull Racing',
  3: 'Williams',
  4: 'Aston Martin',
  5: 'Alpine',
  6: 'RB / AlphaTauri',
  7: 'Haas',
  8: 'McLaren',
  9: 'Sauber / Alfa Romeo',
  // Multiplayer / custom
  41: 'Custom Team',
  104: 'F1 Custom Team',
}

export const SESSION_TYPE_NAMES: Record<number, string> = {
  0: 'unknown',
  1: 'practice', 2: 'practice', 3: 'practice', 4: 'practice',
  5: 'qualifying', 6: 'qualifying', 7: 'qualifying', 8: 'qualifying', 9: 'qualifying',
  10: 'sprint_qualifying', 11: 'sprint_qualifying', 12: 'sprint_qualifying',
  13: 'sprint_race', 14: 'sprint_race',
  15: 'race', 16: 'race', 17: 'race',
  18: 'time_trial',
}

export const WEATHER_NAMES: Record<number, string> = {
  0: 'clear', 1: 'light_cloud', 2: 'overcast', 3: 'light_rain', 4: 'heavy_rain', 5: 'storm',
}

export const VISUAL_COMPOUND_NAMES: Record<number, string> = {
  16: 'soft', 17: 'medium', 18: 'hard', 7: 'inter', 8: 'wet',
}

// F1 penalty types (official UDP spec)
export const PENALTY_TYPE_NAMES: Record<number, string> = {
  0: 'Drive-through', 1: 'Stop-Go', 2: 'Grid penalty', 3: 'Penalty reminder',
  4: 'Time penalty', 5: 'Warning', 6: 'Disqualified', 7: 'Removed from formation lap',
  8: 'Parked too long', 9: 'Tyre regulations', 10: 'Lap invalidated',
  11: 'This & next lap invalidated', 12: 'Lap invalidated (no reason)',
  13: 'This & next lap invalidated (no reason)', 14: 'This & previous lap invalidated',
  15: 'This & previous lap invalidated (no reason)', 16: 'Retired', 17: 'Black flag timer',
}

// F1 infringement types (official UDP spec) — common subset, generic fallback
export const INFRINGEMENT_NAMES: Record<number, string> = {
  0: 'Blocking by slow driving', 1: 'Blocking by wrong way', 2: 'Reversing off start line',
  3: 'Big collision', 4: 'Small collision', 5: 'Collision — failed to hand back position',
  6: 'Collision — failed to hand back position (multiple)', 7: 'Corner cutting — time gained',
  8: 'Corner cutting — single time gain', 9: 'Corner cutting — multiple time gain',
  10: 'Crossed pit exit lane', 11: 'Ignoring blue flags', 12: 'Ignoring yellow flags',
  13: 'Ignoring drive-through', 14: 'Too many drive-throughs', 15: 'Drive-through reminder (short)',
  16: 'Drive-through reminder (long)', 17: 'Pit lane speeding', 18: 'Parked too long',
  19: 'Ignoring tyre regulations', 20: 'Too many penalties', 21: 'Multiple warnings',
  22: 'Approaching disqualification', 23: 'Tyre regulations (select single)',
  24: 'Tyre regulations (select multiple)', 25: 'Lap invalidated — corner cutting',
  26: 'Lap invalidated — running wide', 27: 'Corner cutting — ran wide (time gain)',
  28: 'Corner cutting — ran wide (minor)', 29: 'Corner cutting — ran wide (major)',
  30: 'Wall riding', 31: 'Flashback used', 32: 'Reset to track', 33: 'Blocking pit lane',
  34: 'Jump start', 35: 'Safety car to car collision', 36: 'Safety car illegal overtake',
  37: 'Safety car exceeding allowed pace', 38: 'Virtual safety car exceeding pace',
  39: 'Formation lap below allowed speed', 40: 'Retired mechanical failure', 41: 'Retired terminally damaged',
  42: 'Safety car falling too far back', 43: 'Black flag timer', 44: 'Unserved stop-go',
  45: 'Unserved drive-through', 46: 'Engine component change', 47: 'Gearbox change',
  48: 'Parc fermé change', 49: 'League grid penalty', 50: 'Retry penalty',
  51: 'Illegal time gain', 52: 'Mandatory pit stop', 53: 'Attribute assigned',
}

export function playerOffset(playerIndex: number, structSize: number): number {
  return HEADER_SIZE + playerIndex * structSize
}

/** Tyre array order in the spec is [RL, RR, FL, FR]. */
export function tyreArray(read: (i: number) => number) {
  return { rl: read(0), rr: read(1), fl: read(2), fr: read(3) }
}
