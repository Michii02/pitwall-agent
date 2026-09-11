import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TelemetryHealth } from '../src/health/state'

test('idle heartbeat stays fresh and game packets change health', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const health = new TelemetryHealth()
  let updates = 0
  health.onStateChange(() => { updates++ })
  health.onListening(20779)
  for (let i = 0; i < 10; i++) t.mock.timers.tick(2000)
  assert.equal(health.snapshot().state, 'WAITING_FOR_GAME')
  const before = updates
  for (let i = 0; i < 5; i++) t.mock.timers.tick(2000)
  assert.equal(updates - before, 5)
  health.onPacket(2025)
  assert.equal(health.snapshot().state, 'RECEIVING')
  for (let i = 0; i < 4; i++) t.mock.timers.tick(2000)
  assert.equal(health.snapshot().state, 'DEGRADED')
  health.stop()
})

test('raw or malformed datagrams do not claim telemetry is receiving', () => {
  const health = new TelemetryHealth()
  health.onListening(20779, '0.0.0.0')
  health.onDatagram({ address: '127.0.0.1', port: 53120 })
  health.onMalformedPacket()

  const snapshot = health.snapshot()
  assert.equal(snapshot.state, 'LISTENING')
  assert.equal(snapshot.datagramsReceived, 1)
  assert.equal(snapshot.validPacketsReceived, 0)
  assert.equal(snapshot.malformedPackets, 1)
  assert.deepEqual(snapshot.packetSource, { address: '127.0.0.1', port: 53120 })
  assert.equal(snapshot.lastValidPacketAt, null)
  health.stop()
})

test('a validated packet records session identity and enters receiving', () => {
  const health = new TelemetryHealth()
  health.onListening(20779, '0.0.0.0')
  health.onDatagram({ address: '127.0.0.1', port: 53120 }, 2025)
  health.onValidPacket({ packetFormat: 2025, sessionUid: 'abc123', playerVehicleIndex: 7 })

  const snapshot = health.snapshot()
  assert.equal(snapshot.state, 'RECEIVING')
  assert.equal(snapshot.validPacketsReceived, 1)
  assert.equal(snapshot.sessionUid, 'abc123')
  assert.equal(snapshot.playerVehicleIndex, 7)
  assert.ok(snapshot.lastValidPacketAt)
  health.stop()
})

test('listener rebind resets transport state and valid telemetry recovers it', () => {
  const health = new TelemetryHealth()
  health.onListening(20779, '0.0.0.0')
  health.onPacket(2025)
  assert.equal(health.snapshot().state, 'RECEIVING')

  health.onListening(20779, '0.0.0.0')
  assert.equal(health.snapshot().state, 'LISTENING')
  assert.equal(health.snapshot().lastValidPacketAt, null)
  health.onPacket(2025)
  assert.equal(health.snapshot().state, 'RECEIVING')
  health.stop()
})
