import type { VersionLayout } from './common'

/** F1 23 — packet format 2023. */
export const F1_2023: VersionLayout = {
  gameVersion: 'f1_2023',
  packetFormat: 2023,
  lapDataSize: 53,
  carSetupSize: 49,
  setupHasEngineBraking: false,
  carStatusSize: 55,
  carDamageSize: 42,
  participantSize: 58,
  finalClassificationSize: 45,
  lapHistorySize: 14,
  historyHasMinutes: true,
  hasTyreSets: true,
  tyreSetSize: 10,
}
