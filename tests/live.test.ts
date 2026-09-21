import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toLegacyMessage } from '../src/sync/live'
import type { ParseResult } from '../src/udp/parser'
import { TEAM_NAMES } from '../src/udp/packets/common'

const header = { packetFormat: 2025, packetId: 2, sessionUid: 'abc', playerCarIndex: 3 }

function dataOf(message: object | null): Record<string, unknown> {
  assert.ok(message && 'data' in message)
  return message.data as Record<string, unknown>
}

test('live lap payload exposes bounded opponent facts without changing player fields', () => {
  const packet: ParseResult = {
    header,
    gameVersion: 'f1_2025',
    packet: {
      kind: 'lap', lastLapMs: 90_000, currentLapMs: 20_000, sector1Ms: 30_000,
      sector2Ms: 0, sector: 1, carPosition: 4, lapNumber: 8, pitStatus: 0,
      numPitStops: 1, lapInvalid: false, gridPosition: 6, driverStatus: 4,
      resultStatus: 2, lapDistance: 1_000, penaltiesSeconds: 3,
      grid: [
        { vehicleIndex: 7, lastLapMs: 89_500, currentLapMs: 19_000, sector1Ms: 29_900, sector2Ms: 0, carPosition: 3, lapNumber: 8, pitStatus: 0, numPitStops: 1, penaltiesSeconds: 0, lapInvalid: false, driverStatus: 4, resultStatus: 2, gridPosition: 2, lapDistance: 1_100, totalDistance: 40_000, gapAheadMs: 400, gapToLeaderMs: 4_158 },
        { vehicleIndex: 3, lastLapMs: 90_000, currentLapMs: 20_000, sector1Ms: 30_000, sector2Ms: 0, carPosition: 4, lapNumber: 8, pitStatus: 0, numPitStops: 1, penaltiesSeconds: 3, lapInvalid: false, driverStatus: 4, resultStatus: 2, gridPosition: 6, lapDistance: 1_000, totalDistance: 39_900, gapAheadMs: 842, gapToLeaderMs: 5_000 },
        { vehicleIndex: 9, lastLapMs: 90_100, currentLapMs: 20_500, sector1Ms: 30_200, sector2Ms: 0, carPosition: 5, lapNumber: 8, pitStatus: 0, numPitStops: 1, penaltiesSeconds: 5, lapInvalid: false, driverStatus: 4, resultStatus: 2, gridPosition: 7, lapDistance: 900, totalDistance: 39_800, gapAheadMs: 1_305, gapToLeaderMs: 6_305 },
      ],
    },
  }
  const message = dataOf(toLegacyMessage(packet, true, 123))
  const grid = message.grid as Array<Record<string, unknown>>
  assert.equal(message.lastLapMs, 90_000)
  assert.equal(message.driverStatus, 4)
  assert.equal(message.resultStatus, 2)
  assert.equal(message.gapAheadMs, 842)
  assert.equal(message.gapBehindMs, 1_305)
  assert.equal(message.aheadVehicleIndex, 7)
  assert.equal(message.behindVehicleIndex, 9)
  assert.equal(grid.length, 3)
  assert.equal(grid[0].currentLapMs, 19_000)
  assert.equal(grid[2].penaltiesSeconds, 5)

  const unthrottled = dataOf(toLegacyMessage(packet, false, 124))
  assert.equal('grid' in unthrottled, false)
})

test('live status and damage payloads carry deterministic engineer fields', () => {
  const telemetry = dataOf(toLegacyMessage({
    header, gameVersion: 'f1_2025',
    packet: { kind: 'carTelemetry', speed: 280, throttle: 1, steer: 0, brake: 0, clutch: 0, gear: 8, rpm: 11_500, drs: true, revLightsPercent: 80,
      brakesTemperature: { fl: 500, fr: 501, rl: 450, rr: 451 }, tyreSurfaceTemp: { fl: 96, fr: 97, rl: 94, rr: 95 }, tyreInnerTemp: { fl: 90, fr: 91, rl: 88, rr: 89 }, tyrePressure: { fl: 23.1, fr: 23.2, rl: 21.1, rr: 21.2 } },
  }, true, 122))
  assert.deepEqual(telemetry.tyreSurfaceTemp, { fl: 96, fr: 97, rl: 94, rr: 95 })
  assert.deepEqual(telemetry.tyreInnerTemp, { fl: 90, fr: 91, rl: 88, rr: 89 })
  assert.deepEqual(telemetry.tyrePressure, { fl: 23.1, fr: 23.2, rl: 21.1, rr: 21.2 })

  const status = dataOf(toLegacyMessage({
    header, gameVersion: 'f1_2025',
    packet: { kind: 'status', fuelInTank: 18, fuelMix: 0, visualTyreCompound: 17, actualTyreCompound: 12, tyresAgeLaps: 6, ersStoreEnergy: 3_000_000, ersDeployMode: 2, ersDeployedThisLap: 0, ersHarvestedThisLap: 0, vehicleFiaFlags: 0, grid: [{ vehicleIndex: 7, fuelInTank: 17, actualTyreCompound: 16, visualTyreCompound: 16, tyresAgeLaps: 4, vehicleFiaFlags: 1 }] },
  }, true, 123))
  assert.equal(status.ersStoreEnergy, 3_000_000)
  assert.equal(status.ersDeployedThisLap, 0)
  assert.equal(status.ersHarvestedThisLap, 0)
  assert.equal(status.vehicleFiaFlags, 0)
  assert.deepEqual(status.grid, [{ vehicleIndex: 7, fuelInTank: 17, actualTyreCompound: 16, visualTyreCompound: 16, tyresAgeLaps: 4, vehicleFiaFlags: 1 }])

  const statusWithoutGrid = dataOf(toLegacyMessage({
    header, gameVersion: 'f1_2025',
    packet: { kind: 'status', fuelInTank: 18, fuelMix: 0, visualTyreCompound: 17, actualTyreCompound: 12, tyresAgeLaps: 6, ersStoreEnergy: 3_000_000, ersDeployMode: 2, ersDeployedThisLap: 0, ersHarvestedThisLap: 0, vehicleFiaFlags: 0, grid: [{ vehicleIndex: 7, fuelInTank: 17, actualTyreCompound: 16, visualTyreCompound: 16, tyresAgeLaps: 4, vehicleFiaFlags: 1 }] },
  }, false, 124))
  assert.equal('grid' in statusWithoutGrid, false)

  const damage = dataOf(toLegacyMessage({
    header, gameVersion: 'f1_2025',
    packet: { kind: 'damage', tyreWear: { fl: 10, fr: 11, rl: 8, rr: 9 }, frontLeftWing: 0, frontRightWing: 5, rearWing: 0, floor: 0, diffuser: 0, sidepod: 0, gearbox: 0, engine: 0 },
  }, true, 123))
  assert.equal(damage.frontRightWing, 5)
  assert.deepEqual(damage.tyresWear, { fl: 10, fr: 11, rl: 8, rr: 9 })
})

test('live participant payload includes identity and constructor context', () => {
  const message = dataOf(toLegacyMessage({
    header, gameVersion: 'f1_2025',
    packet: { kind: 'participant', driverName: 'Player', teamId: 1, raceNumber: 4, grid: [{ vehicleIndex: 3, driverName: 'Player', teamId: 1, raceNumber: 4, aiControlled: false, networkId: 1, nationality: 0, platform: 1 }, { vehicleIndex: 7, driverName: 'Alex Morgan', teamId: 2, raceNumber: 7, aiControlled: true, networkId: 2, nationality: 0, platform: 1 }] },
  }, true, 123))
  assert.deepEqual(message.participants, [
    { vehicleIndex: 3, driverName: 'Player', teamId: 1, teamName: TEAM_NAMES[1] ?? null, raceNumber: 4 },
    { vehicleIndex: 7, driverName: 'Alex Morgan', teamId: 2, teamName: TEAM_NAMES[2] ?? null, raceNumber: 7 },
  ])
})
