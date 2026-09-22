import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionCollector } from '../src/session/collector'
import type { LapPacket, SessionPacket, StatusPacket } from '../src/udp/packets/common'

const session = (safetyCarStatus: number): SessionPacket => ({ kind: 'session', trackId: 11, formula: 0, sessionType: 10, totalLaps: 10, weather: 0,
  trackTemperature: 30, airTemperature: 20, safetyCarStatus, sessionTimeLeft: 1000, aiDifficulty: null })
const lap = (lapNumber: number, lastLapMs: number): LapPacket => ({ kind: 'lap', lapNumber, lastLapMs, currentLapMs: 1_000, sector1Ms: 30_000, sector2Ms: 30_000,
  lapInvalid: false, pitStatus: 0, driverStatus: 4, resultStatus: 2, carPosition: 4, gridPosition: 4, numPitStops: 0, penaltiesSeconds: 0, sector: 0, lapDistance: 10 })
const status = (vehicleFiaFlags: number): StatusPacket => ({ kind: 'status', fuelInTank: 20, fuelMix: 0, visualTyreCompound: 17,
  actualTyreCompound: 12, tyresAgeLaps: 2, ersStoreEnergy: 3_000_000, ersDeployMode: 2, ersDeployedThisLap: 0,
  ersHarvestedThisLap: 0, vehicleFiaFlags })

test('formation laps are not persisted as Safety Car/VSC affected laps', () => {
  const collector = new SessionCollector('f1_2025', session(3))
  collector.updateSession(session(3))
  collector.updateLap(lap(1, 0))
  collector.updateLap(lap(2, 90_000))
  assert.equal(collector.record.laps[0].safety_car_this_lap, false)

  collector.updateSession(session(1))
  collector.updateLap(lap(3, 90_100))
  assert.equal(collector.record.laps[1].safety_car_this_lap, true)
})

test('persists explainable track-state transitions without creating incidents', () => {
  const collector = new SessionCollector('f1_2025', session(0))
  collector.updateStatus(status(3))
  collector.updateStatus(status(3))
  collector.updateSession(session(1))
  collector.updateSession(session(0))
  collector.updateStatus(status(0))

  assert.deepEqual(collector.record.track_state_events?.map((event) => event.state), [
    'green', 'local_yellow', 'safety_car', 'local_yellow', 'green',
  ])
  assert.equal(collector.record.track_state_events?.[1].source, 'player_fia_flag')
  assert.equal(collector.record.incidents.length, 0)
})

test('track-state history survives collector recovery without duplicate transitions', () => {
  const collector = new SessionCollector('f1_2025', session(0))
  collector.updateStatus(status(3))

  const restored = SessionCollector.restore('f1_2025', session(0), collector.recoveryState())
  restored.updateStatus(status(3))
  restored.updateStatus(status(0))

  assert.deepEqual(restored.record.track_state_events?.map((event) => event.state), ['green', 'local_yellow', 'green'])
})
