import type { VersionLayout } from './common'

/**
 * F1 25 — packet format 2025.
 * Car setup gained an engineBraking byte after brakeBias, shifting the tyre
 * pressures / ballast / fuel-load fields by +1 (verified against live data).
 */
export const F1_2025: VersionLayout = {
  gameVersion: 'f1_2025',
  packetFormat: 2025,
  lapDataSize: 57,
  carSetupSize: 50,
  setupHasEngineBraking: true,
  carStatusSize: 55,
  carDamageSize: 42,
  participantSize: 60,
  finalClassificationSize: 46,
  lapHistorySize: 14,
  historyHasMinutes: true,
  hasTyreSets: true,
  tyreSetSize: 10,
}
