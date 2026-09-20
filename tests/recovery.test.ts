import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionQueue } from '../src/sync/queue'
import { SessionLifecycle } from '../src/session/lifecycle'
import { isActiveSessionCheckpoint } from '../src/session/checkpoint'
import type { ParseResult } from '../src/udp/parser'
import type { LapPacket, SessionPacket, CarTelemetryPacket } from '../src/udp/packets/common'

const address = '127.0.0.1', owner = '0'.repeat(64)
const session: SessionPacket = { kind: 'session', trackId: 11, formula: 0, sessionType: 10, totalLaps: 29, weather: 0,
  trackTemperature: 30, airTemperature: 20, safetyCarStatus: 0, sessionTimeLeft: 1000, aiDifficulty: null }
function result(packet: ParseResult['packet'], uid = '0000000000000001'): ParseResult {
  return { gameVersion: 'f1_2025', header: { packetFormat: 2025, packetId: 1, sessionUid: uid, playerCarIndex: 0 }, packet }
}
function lap(number: number, last = 0): LapPacket {
  return { kind: 'lap', lapNumber: number, lastLapMs: last, currentLapMs: 1000, sector1Ms: 0, sector2Ms: 0, lapInvalid: false,
    pitStatus: 0, driverStatus: 1, resultStatus: 2, carPosition: 4, gridPosition: 4, numPitStops: 0, penaltiesSeconds: 0, sector: 0, lapDistance: 10 }
}
const telemetry: CarTelemetryPacket = { kind: 'carTelemetry', speed: 100, throttle: 0, brake: 0, steer: 0, gear: 3, rpm: 8000, drs: 0,
  tyreSurfaceTemp: { fl: 80, fr: 80, rl: 80, rr: 80 }, tyreInnerTemp: { fl: 80, fr: 80, rl: 80, rr: 80 }, tyrePressure: { fl: 20, fr: 20, rl: 20, rr: 20 } }
function create(queue: SessionQueue) {
  const lifecycle = new SessionLifecycle({
    onStateChange: () => {}, onLapComplete: () => {}, onSessionComplete: async () => {},
    onCaptureFinalized: (record) => queue.completeActiveSession(record),
    onCheckpoint: () => { const checkpoint = lifecycle.createCheckpoint(address, owner); if (checkpoint) queue.saveActiveCheckpoint(checkpoint) },
  }, { platform: 'PLAYSTATION', captureMethod: 'CONSOLE_DESKTOP', platformOrigin: 'detected', sourceDeviceId: 'qa-ps' })
  return lifecycle
}
function start(lifecycle: SessionLifecycle) {
  lifecycle.feed(result(session)); lifecycle.feed(result({ kind: 'event', code: 'SSTA' }))
  lifecycle.feed(result(lap(1))); lifecycle.feed(result(telemetry)); lifecycle.feed(result(lap(2, 90_000)))
}
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-recovery-'))
  return { dir, file: path.join(dir, 'queue.db') }
}

test('65 and 120 second interruptions preserve one capture and a durable gap', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
  const { dir, file } = temporary(), queue = new SessionQueue(file), lifecycle = create(queue)
  try {
    start(lifecycle)
    const id = queue.loadActiveCheckpoint()!.collector.record.id
    context.mock.timers.tick(65_000)
    assert.equal(lifecycle.snapshot.active, true)
    assert.equal(queue.pendingCount(), 0)
    assert.equal(queue.loadActiveCheckpoint()!.collector.record.telemetry_gaps!.length, 1)
    context.mock.timers.tick(55_000)
    lifecycle.feed(result(session)); lifecycle.feed(result(telemetry)); lifecycle.stop()
    const checkpoint = queue.loadActiveCheckpoint()!
    assert.equal(checkpoint.collector.record.id, id)
    assert.equal(checkpoint.collector.record.telemetry_gaps![0].end_received_at_ms, 1_120_000)
    assert.equal(checkpoint.collector.record.telemetry_samples.at(-1)!.gap_before, true)
  } finally { lifecycle.stop(); queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('restart resumes matching fresh session with same ID and avoids duplicate or invented laps', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
  const { dir, file } = temporary()
  let queue = new SessionQueue(file), lifecycle = create(queue)
  try {
    start(lifecycle); lifecycle.stop()
    const before = queue.loadActiveCheckpoint()!
    queue.close(); context.mock.timers.tick(120_000)
    queue = new SessionQueue(file); lifecycle = create(queue)
    const checkpoint = queue.loadActiveCheckpoint()!
    assert.equal(lifecycle.restoreRecovery(checkpoint, result(session), address), true)
    lifecycle.feed(result(session)); lifecycle.feed(result(lap(2, 90_000)))
    lifecycle.feed(result(lap(4, 95_000))); lifecycle.stop()
    const after = queue.loadActiveCheckpoint()!.collector.record
    assert.equal(after.id, before.collector.record.id)
    assert.deepEqual(after.laps.map((row) => row.lap_number), [1, 3])
    assert.equal(after.platform, 'PLAYSTATION')
    assert.equal(after.source_device_id, 'qa-ps')
    assert.equal(after.telemetry_gaps![0].reason, 'agent_restart')
    lifecycle.feed(result({ kind: 'event', code: 'SEND' }))
    assert.equal(queue.loadActiveCheckpoint(), null)
    assert.equal(queue.pendingCount(), 1)
  } finally { lifecycle.stop(); queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('different identity preserves the old capture as abandoned instead of merging', () => {
  const { dir, file } = temporary(), queue = new SessionQueue(file), lifecycle = create(queue)
  const restored = create(queue)
  try {
    start(lifecycle); lifecycle.stop()
    const checkpoint = queue.loadActiveCheckpoint()!
    assert.equal(restored.restoreRecovery(checkpoint, result(session, '0000000000000002'), address), false)
    assert.equal(queue.loadActiveCheckpoint(), null)
    assert.equal(queue.pendingSessions()[0].record.id, checkpoint.collector.record.id)
    assert.equal(queue.pendingSessions()[0].record.abandoned, true)
  } finally { lifecycle.stop(); restored.stop(); queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('recovery requires fresh Session data and matching source/track/type/layout', () => {
  const { dir, file } = temporary(), queue = new SessionQueue(file), lifecycle = create(queue)
  try {
    start(lifecycle); lifecycle.stop()
    const checkpoint = queue.loadActiveCheckpoint()!
    const restored = create(queue)
    assert.equal(restored.restoreRecovery(checkpoint, result(lap(2)), address), false)
    assert.equal(restored.snapshot.active, false)
    restored.stop()
    for (const [fresh, sender] of [[result({ ...session, trackId: 12 }), address], [result(session), '127.0.0.2'],
      [result({ ...session, sessionType: 5 }), address], [{ ...result(session), header: { ...result(session).header, packetFormat: 2024 } }, address]] as const) {
      const other = create(queue)
      assert.equal(other.restoreRecovery(checkpoint, fresh, sender), false)
      other.stop()
    }
  } finally { lifecycle.stop(); queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('atomic finalization rejects stale checkpoints and cannot queue duplicate captures', () => {
  const { dir, file } = temporary(), queue = new SessionQueue(file), lifecycle = create(queue)
  try {
    start(lifecycle); lifecycle.stop()
    const checkpoint = queue.loadActiveCheckpoint()!
    queue.completeActiveSession(checkpoint.collector.record)
    queue.saveActiveCheckpoint(checkpoint)
    queue.completeActiveSession(checkpoint.collector.record)
    assert.equal(queue.loadActiveCheckpoint(), null)
    assert.equal(queue.pendingCount(), 1)
  } finally { queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
test('corrupt recovery state and pairing changes are quarantined without inventing telemetry', () => {
  const { dir, file } = temporary(), queue = new SessionQueue(file), lifecycle = create(queue)
  try {
    start(lifecycle); lifecycle.stop()
    const checkpoint = queue.loadActiveCheckpoint()!
    assert.equal(isActiveSessionCheckpoint(checkpoint), true)
    assert.equal(isActiveSessionCheckpoint({ ...checkpoint, version: 2 }), false)
    assert.equal(isActiveSessionCheckpoint({ ...checkpoint, ownerFingerprint: 'secret' }), false)
    queue.saveActiveCheckpoint({ ...checkpoint, collector: { ...checkpoint.collector, lastLapNumber: -1 } })
    assert.equal(queue.loadActiveCheckpoint(), null)
    assert.equal(queue.pendingCount(), 0)
  } finally { queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('checkpoint validation rejects malformed samples, gaps and session context before recovery', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
  const { dir, file } = temporary(), queue = new SessionQueue(file), lifecycle = create(queue)
  try {
    start(lifecycle); lifecycle.stop()
    const valid = queue.loadActiveCheckpoint()!
    assert.equal(isActiveSessionCheckpoint(valid), true)
    // Deliberately corrupt arbitrary nested fields to exercise the runtime trust boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mutations: Array<(value: any) => void> = [
      (v) => { v.collector.record.telemetry_samples = [null] },
      (v) => { delete v.collector.record.telemetry_samples[0].t },
      (v) => { v.collector.record.telemetry_samples[0].gap_before = 'yes' },
      (v) => { v.collector.record.telemetry_samples[0].thr = 2 },
      (v) => { v.collector.record.telemetry_samples[0].steer = Infinity },
      (v) => { v.collector.record.telemetry_samples[0].tS = [80] },
      (v) => { v.collector.record.telemetry_gaps = {} },
      (v) => { v.collector.record.telemetry_gaps = [null] },
      (v) => { v.collector.record.telemetry_gaps = [{ reason: 'silence', start_received_at_ms: 10, end_received_at_ms: 10, start_sample_time_ms: 0, end_sample_time_ms: 5 }] },
      (v) => { v.collector.record.telemetry_gaps = [{ reason: 'agent_restart', start_received_at_ms: 10, end_received_at_ms: null, start_sample_time_ms: 0, end_sample_time_ms: 5 }] },
      (v) => { delete v.sessionPacket.weather },
      (v) => { v.sessionPacket.sessionType = 255 },
      (v) => { v.collector.record.session_type = 'practice' },
      (v) => { v.sessionPacket.aiDifficulty = 111 },
    ]
    for (const mutate of mutations) {
      const corrupted = structuredClone(valid)
      mutate(corrupted)
      assert.equal(isActiveSessionCheckpoint(corrupted), false)
    }
    const corrupted = structuredClone(valid)
    corrupted.collector.record.telemetry_samples = [null as never]
    queue.saveActiveCheckpoint(corrupted)
    assert.equal(queue.loadActiveCheckpoint(), null)
    assert.equal(queue.pendingCount(), 0)
  } finally { queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('failed durable finalization retains original capture and retries without duplicate data', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
  const { dir, file } = temporary(), queue = new SessionQueue(file)
  let fail = true, uploads = 0
  const lifecycle = new SessionLifecycle({ onStateChange: () => {}, onLapComplete: () => {},
    onSessionComplete: async () => { uploads++ },
    onCaptureFinalized: (record) => { if (fail) throw new Error('disk unavailable'); queue.completeActiveSession(record) },
    onCheckpoint: () => { const cp = lifecycle.createCheckpoint(address, owner); if (cp) queue.saveActiveCheckpoint(cp) },
  })
  try {
    start(lifecycle); lifecycle.stop()
    const before = queue.loadActiveCheckpoint()!
    assert.throws(() => lifecycle.feed(result({ kind: 'event', code: 'SEND' })), /disk unavailable/)
    assert.equal(lifecycle.snapshot.active, true)
    assert.equal(queue.pendingCount(), 0)
    assert.equal(uploads, 0)
    const retained = lifecycle.createCheckpoint(address, owner)!
    assert.equal(retained.collector.record.id, before.collector.record.id)
    assert.deepEqual(retained.collector.record.laps, before.collector.record.laps)
    assert.deepEqual(retained.collector.record.telemetry_samples, before.collector.record.telemetry_samples)
    fail = false
    lifecycle.feed(result({ kind: 'event', code: 'SEND' }))
    assert.equal(lifecycle.snapshot.active, false)
    assert.equal(queue.loadActiveCheckpoint(), null)
    assert.equal(queue.pendingCount(), 1)
    assert.equal(queue.pendingSessions()[0].record.id, before.collector.record.id)
    assert.equal(uploads, 1)
  } finally { lifecycle.stop(); queue.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
