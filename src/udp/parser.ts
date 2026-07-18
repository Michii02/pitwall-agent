/**
 * Packet version router + field extraction.
 *
 * Reads the packet-format version from the 29-byte header, routes to the
 * matching VersionLayout (F1 23/24/25), and extracts only the fields PitWall
 * needs. Unknown format versions are logged once and discarded.
 */

import {
  HEADER_SIZE, OFF_PACKET_FORMAT, OFF_PACKET_ID, OFF_SESSION_UID_LO, OFF_PLAYER_CAR_INDEX,
  PACKET, playerOffset, tyreArray,
  type ParsedHeader, type ParsedPacket, type VersionLayout, type GameVersion,
} from './packets/common'
import { F1_2023 } from './packets/f1-2023'
import { F1_2024 } from './packets/f1-2024'
import { F1_2025 } from './packets/f1-2025'
import { log } from '../utils/logger'

const LAYOUTS: Record<number, VersionLayout> = {
  2023: F1_2023,
  2024: F1_2024,
  2025: F1_2025,
}

const warnedFormats = new Set<number>()

export function parseHeader(buf: Buffer): ParsedHeader | null {
  if (buf.length < HEADER_SIZE) return null
  const lo = buf.readUInt32LE(OFF_SESSION_UID_LO)
  const hi = buf.readUInt32LE(OFF_SESSION_UID_LO + 4)
  return {
    packetFormat: buf.readUInt16LE(OFF_PACKET_FORMAT),
    packetId: buf.readUInt8(OFF_PACKET_ID),
    sessionUid: `${hi.toString(16)}${lo.toString(16).padStart(8, '0')}`,
    playerCarIndex: buf.readUInt8(OFF_PLAYER_CAR_INDEX),
  }
}

export interface ParseResult {
  header: ParsedHeader
  gameVersion: GameVersion
  packet: ParsedPacket
}

export function parsePacket(buf: Buffer, versionOverride?: GameVersion): ParseResult | null {
  const header = parseHeader(buf)
  if (!header) return null

  let layout = LAYOUTS[header.packetFormat]
  if (versionOverride) {
    layout = Object.values(LAYOUTS).find((l) => l.gameVersion === versionOverride) ?? layout
  }
  if (!layout) {
    if (!warnedFormats.has(header.packetFormat)) {
      warnedFormats.add(header.packetFormat)
      if (header.packetFormat === 2026) {
        // F1 25: 2026 Season Pack. Recognised, but its packet layout isn't
        // independently verified yet (see vehicleEra.ts) — discarding rather
        // than guess-parsing avoids silently misreading real telemetry.
        // Note: this means vehicle-era detection (via the Session packet's
        // formula field) only works today when the player's own UDP output
        // format is still 2023/2024/2025 — a session broadcasting natively
        // in 2026 format is entirely unparsed until that layout is verified.
        log.warn('2026 Season Pack UDP format detected — not yet supported, discarding packet. Switch the in-game UDP Format setting to 2025 to keep recording sessions.')
      } else {
        log.warn(`Unrecognised packet format ${header.packetFormat} — discarding (supported: 2023, 2024, 2025)`)
      }
    }
    return null
  }

  const p = header.playerCarIndex
  let packet: ParsedPacket | null = null

  switch (header.packetId) {
    case PACKET.SESSION: packet = parseSession(buf); break
    case PACKET.LAP_DATA: packet = parseLap(buf, p, layout); break
    case PACKET.EVENT: packet = parseEvent(buf, p); break
    case PACKET.PARTICIPANTS: packet = parseParticipant(buf, p, layout); break
    case PACKET.CAR_SETUPS: packet = parseSetup(buf, p, layout); break
    case PACKET.CAR_TELEMETRY: packet = parseCarTelemetry(buf, p); break
    case PACKET.CAR_STATUS: packet = parseStatus(buf, p, layout); break
    case PACKET.FINAL_CLASSIFICATION: packet = parseClassification(buf, p, layout); break
    case PACKET.CAR_DAMAGE: packet = parseDamage(buf, p, layout); break
    case PACKET.SESSION_HISTORY: packet = parseHistory(buf, p, layout); break
    case PACKET.TYRE_SETS: packet = layout.hasTyreSets ? parseTyreSets(buf, layout) : null; break
    // MOTION (0), LOBBY_INFO (9): intentionally skipped
    default: packet = null
  }

  if (!packet) return null
  return { header, gameVersion: layout.gameVersion, packet }
}

// ── Individual packet parsers ─────────────────────────────────────────────────

function parseSession(buf: Buffer): ParsedPacket | null {
  if (buf.length < HEADER_SIZE + 126) return null
  const b = HEADER_SIZE
  return {
    kind: 'session',
    weather: buf.readUInt8(b + 0),
    trackTemperature: buf.readInt8(b + 1),
    airTemperature: buf.readInt8(b + 2),
    totalLaps: buf.readUInt8(b + 3),
    sessionType: buf.readUInt8(b + 6),
    trackId: buf.readInt8(b + 7),
    // m_formula — ruleset identifier, 1 byte between trackId and
    // sessionTimeLeft. 13 = F1 26 (2026 Season Pack); see vehicleEra.ts.
    formula: buf.readUInt8(b + 8),
    sessionTimeLeft: buf.readUInt16LE(b + 9),
    // After: pitSpeedLimit, gamePaused, isSpectating, spectatorCarIdx,
    // sliProSupport, numMarshalZones, 21×5-byte marshal zones = offset 124
    safetyCarStatus: buf.readUInt8(b + 124),
  }
}

function parseLap(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  const base = playerOffset(p, l.lapDataSize)
  if (buf.length < base + l.lapDataSize) return null
  const sectorMs = (msOff: number, minOff: number) =>
    buf.readUInt16LE(base + msOff) + buf.readUInt8(base + minOff) * 60_000
  return {
    kind: 'lap',
    lastLapMs: buf.readUInt32LE(base + 0),
    currentLapMs: buf.readUInt32LE(base + 4),
    sector1Ms: sectorMs(8, 10),
    sector2Ms: sectorMs(11, 13),
    carPosition: buf.readUInt8(base + 32),
    lapNumber: buf.readUInt8(base + 33),
    pitStatus: buf.readUInt8(base + 34),
    numPitStops: buf.readUInt8(base + 35),
    sector: buf.readUInt8(base + 36), // 0/1/2
    lapDistance: buf.readFloatLE(base + 20), // metres into the lap
    lapInvalid: buf.readUInt8(base + 37) === 1,
    // penalties(38) warnings … driverStatus/resultStatus near end of struct
    driverStatus: buf.readUInt8(base + 44),
    resultStatus: buf.readUInt8(base + 45),
    gridPosition: buf.readUInt8(base + 43),
  }
}

function parseEvent(buf: Buffer, playerIdx: number): ParsedPacket | null {
  if (buf.length < HEADER_SIZE + 4) return null
  const code = buf.toString('ascii', HEADER_SIZE, HEADER_SIZE + 4)
  const d = HEADER_SIZE + 4 // event-specific detail union starts here

  if (code === 'PENA' && buf.length >= d + 7) {
    return {
      kind: 'event', code,
      penaltyType: buf.readUInt8(d + 0),
      infringementType: buf.readUInt8(d + 1),
      vehicleIdx: buf.readUInt8(d + 2),
      otherVehicleIdx: buf.readUInt8(d + 3),
      penaltyTime: buf.readUInt8(d + 4),
      lapNum: buf.readUInt8(d + 5),
    }
  }
  if (code === 'COLL' && buf.length >= d + 2) {
    return {
      kind: 'event', code,
      vehicleIdx: buf.readUInt8(d + 0),
      otherVehicleIdx: buf.readUInt8(d + 1),
    }
  }
  void playerIdx // player filtering happens in the lifecycle/collector
  return { kind: 'event', code }
}

function parseParticipant(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  // numActiveCars (1 byte) precedes the participant array
  const base = HEADER_SIZE + 1 + p * l.participantSize
  if (buf.length < base + l.participantSize) return null
  // Struct: aiControlled u8, driverId u8, networkId u8, teamId u8, myTeam u8,
  // raceNumber u8, nationality u8, name char[32 or 48] …
  const teamId = buf.readUInt8(base + 3)
  const raceNumber = buf.readUInt8(base + 5)
  const nameStart = base + 7
  const nameEnd = Math.min(nameStart + 32, buf.length)
  const raw = buf.toString('utf8', nameStart, nameEnd)
  const driverName = raw.split('\0')[0].trim() || 'Player'
  return { kind: 'participant', driverName, teamId, raceNumber }
}

function parseSetup(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  const base = playerOffset(p, l.carSetupSize)
  if (buf.length < base + l.carSetupSize) return null
  // engineBraking (F1 25) sits after brakeBias, shifting later fields by +1
  const shift = l.setupHasEngineBraking ? 1 : 0
  const f = (off: number) => parseFloat(buf.readFloatLE(base + off).toFixed(2))
  return {
    kind: 'setup',
    front_wing: buf.readUInt8(base + 0),
    rear_wing: buf.readUInt8(base + 1),
    on_throttle_diff: buf.readUInt8(base + 2),
    off_throttle_diff: buf.readUInt8(base + 3),
    front_camber: f(4),
    rear_camber: f(8),
    front_toe: f(12),
    rear_toe: f(16),
    front_suspension: buf.readUInt8(base + 20),
    rear_suspension: buf.readUInt8(base + 21),
    front_arb: buf.readUInt8(base + 22),
    rear_arb: buf.readUInt8(base + 23),
    front_ride_height: buf.readUInt8(base + 24),
    rear_ride_height: buf.readUInt8(base + 25),
    brake_pressure: buf.readUInt8(base + 26),
    front_brake_bias: buf.readUInt8(base + 27),
    rear_tyre_pressure: parseFloat(((buf.readFloatLE(base + 28 + shift) + buf.readFloatLE(base + 32 + shift)) / 2).toFixed(1)),
    front_tyre_pressure: parseFloat(((buf.readFloatLE(base + 36 + shift) + buf.readFloatLE(base + 40 + shift)) / 2).toFixed(1)),
    ballast: buf.readUInt8(base + 44 + shift),
    fuel_load: parseFloat(buf.readFloatLE(base + 45 + shift).toFixed(1)),
  }
}

const CAR_TELEMETRY_SIZE = 60 // stable across F1 23/24/25

/** Not persisted — forwarded to the PitWall server for the live view only. */
function parseCarTelemetry(buf: Buffer, p: number): ParsedPacket | null {
  const base = playerOffset(p, CAR_TELEMETRY_SIZE)
  if (buf.length < base + CAR_TELEMETRY_SIZE) return null
  // F1 telemetry tyre arrays are ordered [RL, RR, FL, FR].
  // surface temp: uint8[4] @ +30 · inner temp: uint8[4] @ +34 · pressure: float[4] @ +40
  const surf = (i: number) => buf.readUInt8(base + 30 + i)
  const inner = (i: number) => buf.readUInt8(base + 34 + i)
  const press = (i: number) => Math.round(buf.readFloatLE(base + 40 + i * 4) * 10) / 10
  return {
    kind: 'carTelemetry',
    speed: buf.readUInt16LE(base + 0),
    throttle: buf.readFloatLE(base + 2),
    steer: buf.readFloatLE(base + 6),
    brake: buf.readFloatLE(base + 10),
    gear: buf.readInt8(base + 15),
    rpm: buf.readUInt16LE(base + 16),
    drs: buf.readUInt8(base + 18),
    tyreSurfaceTemp: { rl: surf(0), rr: surf(1), fl: surf(2), fr: surf(3) },
    tyreInnerTemp: { rl: inner(0), rr: inner(1), fl: inner(2), fr: inner(3) },
    tyrePressure: { rl: press(0), rr: press(1), fl: press(2), fr: press(3) },
  }
}

function parseStatus(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  const base = playerOffset(p, l.carStatusSize)
  if (buf.length < base + l.carStatusSize) return null
  return {
    kind: 'status',
    fuelMix: buf.readUInt8(base + 2),
    fuelInTank: buf.readFloatLE(base + 5),
    actualTyreCompound: buf.readUInt8(base + 25),
    visualTyreCompound: buf.readUInt8(base + 26),
    tyresAgeLaps: buf.readUInt8(base + 27),
    vehicleFiaFlags: buf.readInt8(base + 28),
    ersStoreEnergy: buf.readFloatLE(base + 37),
    // ERS deploy mode (uint8 @ +41), harvested MGU-K (+42) + MGU-H (+46),
    // deployed this lap (float @ +50) — stable across F1 23/24/25.
    ersDeployMode: buf.readUInt8(base + 41),
    ersHarvestedThisLap: buf.readFloatLE(base + 42) + buf.readFloatLE(base + 46),
    ersDeployedThisLap: buf.readFloatLE(base + 50),
  }
}

let loggedDamageLayout = false

function parseDamage(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  // Derive the real per-car struct size from the packet length rather than a
  // hardcoded constant: F1 always packs exactly 22 cars, so any version's true
  // size = (length - header) / 22. This self-corrects when a new title (e.g.
  // F1 25 adding tyre-blister fields) changes the struct size, which would
  // otherwise push the player's slot to the wrong offset and read zeros.
  const derived = Math.floor((buf.length - HEADER_SIZE) / 22)
  const size = derived >= l.carDamageSize ? derived : l.carDamageSize
  const base = playerOffset(p, size)
  if (buf.length < base + 34) return null

  // One-time diagnostic so a real session confirms the layout in the log.
  if (!loggedDamageLayout) {
    loggedDamageLayout = true
    const raw = Array.from(buf.subarray(base, base + 20))
    log.info(`[diag] CarDamage len=${buf.length} playerIdx=${p} derivedSize=${derived} usedSize=${size} base=${base} rawBytes=[${raw.join(',')}]`)
  }

  return {
    kind: 'damage',
    // tyresWear: 4 × float32 at offset 0 (RL, RR, FL, FR).
    // Rounded to whole percent to match how the F1 game itself displays wear
    // (the game shows integer %, so the app should too for consistency).
    tyreWear: tyreArray((i) => Math.round(buf.readFloatLE(base + i * 4))),
    // tyresDamage 4×u8 @16, brakesDamage 4×u8 @20, then wing/body damage
    frontLeftWing: buf.readUInt8(base + 24),
    frontRightWing: buf.readUInt8(base + 25),
    rearWing: buf.readUInt8(base + 26),
    floor: buf.readUInt8(base + 27),
    diffuser: buf.readUInt8(base + 28),
    sidepod: buf.readUInt8(base + 29),
    gearbox: buf.readUInt8(base + 32),
    engine: buf.readUInt8(base + 33),
  }
}

function parseClassification(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  // numCars (1 byte) precedes the classification array
  const base = HEADER_SIZE + 1 + p * l.finalClassificationSize
  if (buf.length < base + l.finalClassificationSize) return null
  return {
    kind: 'classification',
    position: buf.readUInt8(base + 0),
    numLaps: buf.readUInt8(base + 1),
    gridPosition: buf.readUInt8(base + 2),
    resultStatus: buf.readUInt8(base + 5),
    bestLapTimeMs: buf.readUInt32LE(base + 6),
    totalRaceTimeSec: buf.readDoubleLE(base + 10),
    penaltiesTimeSec: buf.readUInt8(base + 18),
  }
}

function parseHistory(buf: Buffer, p: number, l: VersionLayout): ParsedPacket | null {
  const b = HEADER_SIZE
  if (buf.length < b + 7) return null
  const carIdx = buf.readUInt8(b + 0)
  if (carIdx !== p) return null // only the player car's history matters
  const numLaps = buf.readUInt8(b + 1)
  const bestLapNumber = buf.readUInt8(b + 3)
  const bestS1Lap = buf.readUInt8(b + 4)
  const bestS2Lap = buf.readUInt8(b + 5)
  const bestS3Lap = buf.readUInt8(b + 6)
  const entriesStart = b + 7
  const laps = []
  for (let i = 0; i < Math.min(numLaps, 100); i++) {
    const e = entriesStart + i * l.lapHistorySize
    if (buf.length < e + l.lapHistorySize) break
    const lapTimeMs = buf.readUInt32LE(e + 0)
    let sector1Ms: number, sector2Ms: number, sector3Ms: number, validOff: number
    if (l.historyHasMinutes) {
      sector1Ms = buf.readUInt16LE(e + 4) + buf.readUInt8(e + 6) * 60_000
      sector2Ms = buf.readUInt16LE(e + 7) + buf.readUInt8(e + 9) * 60_000
      sector3Ms = buf.readUInt16LE(e + 10) + buf.readUInt8(e + 12) * 60_000
      validOff = 13
    } else {
      sector1Ms = buf.readUInt16LE(e + 4)
      sector2Ms = buf.readUInt16LE(e + 6)
      sector3Ms = buf.readUInt16LE(e + 8)
      validOff = 10
    }
    // bit 0 of the valid flags = lap valid
    const valid = (buf.readUInt8(e + validOff) & 0x01) === 0x01
    laps.push({ lapTimeMs, sector1Ms, sector2Ms, sector3Ms, valid })
  }
  return { kind: 'history', carIdx, numLaps, bestLapNumber, bestS1Lap, bestS2Lap, bestS3Lap, laps }
}

function parseTyreSets(buf: Buffer, l: VersionLayout): ParsedPacket | null {
  const b = HEADER_SIZE
  const carIdx = buf.readUInt8(b + 0)
  void carIdx // tyre-sets packet is already player-scoped in practice
  const NUM_SETS = 20
  const setsStart = b + 1
  const sets = []
  for (let i = 0; i < NUM_SETS; i++) {
    const e = setsStart + i * l.tyreSetSize
    if (buf.length < e + l.tyreSetSize) break
    sets.push({
      compound: buf.readUInt8(e + 1), // visual compound
      wear: buf.readUInt8(e + 2),
      available: buf.readUInt8(e + 3) === 1,
      fitted: buf.readUInt8(e + l.tyreSetSize - 1) === 1,
    })
  }
  const fittedIdxOff = setsStart + NUM_SETS * l.tyreSetSize
  const fittedIdx = buf.length > fittedIdxOff ? buf.readUInt8(fittedIdxOff) : 0
  return { kind: 'tyreSets', fittedIdx, sets }
}
