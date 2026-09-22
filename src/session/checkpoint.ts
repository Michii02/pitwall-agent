import { isIP } from 'node:net'
import type { CollectorRecoveryState } from './collector'
import type { GameVersion, SessionPacket } from '../udp/packets/common'
import { SESSION_TYPE_NAMES } from '../udp/packets/common'

export interface ActiveSessionCheckpoint {
  version: 1
  capturedAtMs: number
  lastAcceptedAtMs: number
  sourceAddress: string
  ownerFingerprint: string
  gameVersion: GameVersion
  wireFormat: number
  sessionPacket: SessionPacket
  collector: CollectorRecoveryState
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value: unknown, min: number, max: number): boolean => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const between = (value: unknown, min: number, max: number): boolean => finite(value) && value >= min && value <= max
const tyreTuple = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length === 4 && value.every(nonnegative))
const sample = (value: unknown): boolean => object(value) && nonnegative(value.t)
  && (value.lap === null || integer(value.lap, 0, 1000)) && (value.d === null || finite(value.d))
  && between(value.thr, 0, 1) && between(value.brk, 0, 1) && nonnegative(value.spd)
  && integer(value.gear, -1, 8) && between(value.steer, -1, 1) && nonnegative(value.rpm) && integer(value.drs, 0, 1)
  && (value.gap_before === undefined || typeof value.gap_before === 'boolean')
  && (value.ers === undefined || between(value.ers, 0, 1)) && (value.erm === undefined || integer(value.erm, 0, 3))
  && tyreTuple(value.tS) && tyreTuple(value.tI) && tyreTuple(value.prs)
const gap = (value: unknown): boolean => object(value) && (value.reason === 'silence' || value.reason === 'agent_restart')
  && nonnegative(value.start_received_at_ms) && nonnegative(value.start_sample_time_ms)
  && ((value.end_received_at_ms === null && value.end_sample_time_ms === null)
    || (nonnegative(value.end_received_at_ms) && value.end_received_at_ms > value.start_received_at_ms
      && nonnegative(value.end_sample_time_ms) && value.end_sample_time_ms > value.start_sample_time_ms))
const trackStateEvent = (value: unknown): boolean => object(value)
  && ['green', 'local_yellow', 'red_flag', 'safety_car', 'virtual_safety_car', 'formation', 'unknown'].includes(value.state as string)
  && (value.lap_number === null || integer(value.lap_number, 0, 1000)) && nonnegative(value.observed_at_ms)
  && (value.safety_car_status === null || integer(value.safety_car_status, 0, 3))
  && (value.player_fia_flag === null || integer(value.player_fia_flag, -1, 4))
  && ['session_status', 'player_fia_flag', 'unavailable'].includes(value.source as string)

/** Validate local recovery data before it becomes live telemetry. */
export function isActiveSessionCheckpoint(value: unknown): value is ActiveSessionCheckpoint {
  if (!object(value) || value.version !== 1 || !nonnegative(value.capturedAtMs) || !nonnegative(value.lastAcceptedAtMs) ||
    typeof value.sourceAddress !== 'string' || !isIP(value.sourceAddress) ||
    typeof value.ownerFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(value.ownerFingerprint) ||
    ![2023, 2024, 2025].includes(value.wireFormat as number) ||
    !['f1_2023', 'f1_2024', 'f1_2025'].includes(value.gameVersion as string) || !object(value.sessionPacket) || !object(value.collector)) return false
  const session = value.sessionPacket, state = value.collector
  if (session.kind !== 'session' || !Number.isSafeInteger(session.trackId) || Number(session.trackId) < 0 ||
    !Number.isSafeInteger(session.sessionType) || Number(session.sessionType) <= 0 || !object(state.record) ||
    !nonnegative(state.sessionStartMs) || !Number.isSafeInteger(state.lastLapNumber) || Number(state.lastLapNumber) < 0 ||
    !nonnegative(state.lastLapMs) || !Number.isSafeInteger(state.lastPitStatus) || Number(state.lastPitStatus) < 0 ||
    !Number.isSafeInteger(state.stintStartLap) || Number(state.stintStartLap) < 1) return false
  if (!SESSION_TYPE_NAMES[Number(session.sessionType)] || SESSION_TYPE_NAMES[Number(session.sessionType)] === 'unknown'
    || !integer(session.formula, 0, 255) || !integer(session.totalLaps, 0, 255) || !integer(session.weather, 0, 5)
    || !integer(session.trackTemperature, -128, 127) || !integer(session.airTemperature, -128, 127)
    || !integer(session.safetyCarStatus, 0, 3) || !integer(session.sessionTimeLeft, 0, 65535)
    || !(session.aiDifficulty === null || integer(session.aiDifficulty, 0, 110))) return false
  const record = state.record
  if (typeof record.id !== 'string' || !record.id || record.id.length > 128 || record.source !== 'udp_agent' ||
    typeof record.session_uid !== 'string' || !/^[0-9a-f]{1,16}$/i.test(record.session_uid) ||
    record.track_id !== session.trackId || record.game_version !== value.gameVersion ||
    !Array.isArray(record.laps) || record.laps.length > 1000 || !Array.isArray(record.telemetry_samples) || record.telemetry_samples.length > 6000 ||
    !Array.isArray(record.stints) || !Array.isArray(record.damage_log) || !Array.isArray(record.incidents) ||
    typeof record.session_type !== 'string' || !['PC', 'PLAYSTATION', 'XBOX', 'UNKNOWN'].includes(record.platform as string)) return false
  if (record.session_type !== SESSION_TYPE_NAMES[Number(session.sessionType)] || !record.telemetry_samples.every(sample)
    || !(record.telemetry_gaps === undefined || (Array.isArray(record.telemetry_gaps) && record.telemetry_gaps.length <= 1000 && record.telemetry_gaps.every(gap)))
    || !(record.track_state_events === undefined || (Array.isArray(record.track_state_events) && record.track_state_events.length <= 1000 && record.track_state_events.every(trackStateEvent)))) return false
  if (!record.laps.every((lap: unknown) => object(lap) && Number.isSafeInteger(lap.lap_number) && Number(lap.lap_number) > 0 && nonnegative(lap.lap_time_ms))) return false
  const pending: Array<{ item: unknown; depth: number }> = [{ item: value, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const { item, depth } = pending.pop()!
    if (++visited > 1_000_000 || depth > 32) return false
    if (typeof item === 'number' && !Number.isFinite(item)) return false
    if (Array.isArray(item)) {
      if (item.length > 60_000) return false
      for (const child of item) pending.push({ item: child, depth: depth + 1 })
    } else if (object(item)) {
      for (const child of Object.values(item)) pending.push({ item: child, depth: depth + 1 })
    }
  }
  return true
}
