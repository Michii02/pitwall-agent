import type { VersionLayout } from './common'

/** F1 24 — packet format 2024. */
export const F1_2024: VersionLayout = {
  gameVersion: 'f1_2024',
  packetFormat: 2024,
  lapDataSize: 57,
  carSetupSize: 49,
  setupHasEngineBraking: false,
  carStatusSize: 55,
  carDamageSize: 42,
  participantSize: 60,
  finalClassificationSize: 45,
  lapHistorySize: 14,
  historyHasMinutes: true,
  hasTyreSets: true,
  tyreSetSize: 10,
}
