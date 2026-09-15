import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TelemetrySourceManager } from '../src/sources/manager'
import type { ParseResult } from '../src/udp/parser'
import { TelemetryHealth } from '../src/health/state'
import { processTelemetryDatagram } from '../src/udp/processPacket'

function fixture(code = 3, uid = '0000000000000001'): ParseResult {
  return { gameVersion: 'f1_2025', header: { packetFormat: 2025, packetId: 4, sessionUid: uid, playerCarIndex: 0 },
    packet: { kind: 'participant', driverName: 'QA', teamId: 0, raceNumber: 1, grid: [
      { vehicleIndex: 0, driverName: 'QA', teamId: 0, raceNumber: 1, aiControlled: false, networkId: 0, nationality: 0, platform: code },
    ] } }
}
function session(uid: string): ParseResult {
  return { ...fixture(3, uid), packet: { kind: 'session', trackId: 11, formula: 0, sessionType: 10, totalLaps: 29, weather: 0,
    trackTemperature: 30, airTemperature: 20, safetyCarStatus: 0, sessionTimeLeft: 1000, aiDifficulty: null } }
}
async function withRegistry(run: (manager: TelemetrySourceManager, file: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-sources-'))
  const file = path.join(dir, 'sources.json')
  const manager = new TelemetrySourceManager(file)
  try { await run(manager, file); await manager.flush() } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('known platform identity survives restart and a changed address without claiming hardware model', async () => {
  await withRegistry(async (manager, file) => {
    assert.equal(manager.observe(fixture(), '192.168.1.20', false, undefined, 100).accepted, true)
    const id = manager.captureProfile.sourceDeviceId
    assert.equal(manager.captureProfile.platformOrigin, 'detected')
    await manager.flush()
    const restored = new TelemetrySourceManager(file)
    assert.equal(restored.snapshot(200).sources[0].state, 'offline')
    assert.equal(restored.snapshot(200).sources[0].configurationStatus, 'configured')
    restored.observe(fixture(), '192.168.1.30', false, undefined, 300)
    assert.equal(restored.captureProfile.sourceDeviceId, id)
    assert.equal(restored.snapshot(300).sources[0].name, 'PlayStation source')
    await restored.flush()
  })
})
test('unknown, opponent, invalid player and forced layout evidence do not invent platform', async () => {
  await withRegistry(async (manager) => {
    for (const result of [fixture(255), { ...fixture(), header: { ...fixture().header, playerCarIndex: 22 } },
      { ...fixture(), header: { ...fixture().header, packetFormat: 2024 } }]) {
      manager.observe(result, 'test', false)
      assert.equal(manager.captureProfile.platform, 'UNKNOWN')
    }
    manager.observe(fixture(), 'test', false, undefined, 100, true)
    assert.equal(manager.snapshot().sources.length, 0)
  })
})
test('explicit platform override wins while capture can start with unknown input/platform', async () => {
  await withRegistry(async (manager) => {
    assert.equal(manager.observe(session('1'), 'pc', false).accepted, true)
    assert.equal(manager.captureProfile.platform, 'UNKNOWN')
    manager.observe(fixture(3, '1'), 'pc', true, 'PC')
    assert.equal(manager.captureProfile.platform, 'PC')
    assert.equal(manager.captureProfile.platformOrigin, 'user_selected')
  })
})
test('active-session source lock rejects competing sender without changing capture or configured profile', async () => {
  await withRegistry(async (manager) => {
    manager.observe(fixture(), 'console', false, undefined, 100)
    const before = manager.captureProfile
    assert.equal(manager.observe(fixture(1, '2'), 'pc', true, undefined, 101).accepted, false)
    assert.deepEqual(manager.captureProfile, before)
    assert.equal(manager.snapshot(101).sources.length, 1)
    assert.equal(manager.snapshot(101).sources[0].lastSeenAt, 100)
    assert.equal(manager.snapshot(101).conflictCount, 1)
  })
})
test('PS to PC to restart to PS restores identities without onboarding and rejects stale old packets', async () => {
  await withRegistry(async (manager, file) => {
    manager.observe(fixture(), 'console', false)
    const ps = manager.captureProfile.sourceDeviceId
    assert.equal(manager.observe(fixture(1, '2'), 'pc', false).accepted, false)
    assert.equal(manager.observe(session('2'), 'pc', false).transition, true)
    manager.observe(fixture(1, '2'), 'pc', true)
    assert.equal(manager.captureProfile.platform, 'PC')
    assert.equal(manager.observe(session('0000000000000001'), 'console', false).accepted, false)
    await manager.flush()
    const restored = new TelemetrySourceManager(file)
    restored.observe(fixture(3, '3'), 'console', false)
    assert.equal(restored.captureProfile.sourceDeviceId, ps)
    assert.equal(restored.snapshot().sources.length, 2)
    await restored.flush()
  })
})
test('normal gaps change health without erasing saved setup or identity', async () => {
  await withRegistry(async (manager) => {
    manager.observe(fixture(), 'console', false, undefined, 100)
    const id = manager.captureProfile.sourceDeviceId
    assert.equal(manager.snapshot(5000).sources[0].state, 'interrupted')
    assert.equal(manager.snapshot(20000).sources[0].state, 'offline')
    manager.observe(session('0000000000000001'), 'console', true, undefined, 30000)
    assert.equal(manager.captureProfile.sourceDeviceId, id)
    assert.equal(manager.snapshot(30000).sources[0].state, 'receiving')
  })
})
test('corrupt registry recovers safely without claiming saved sources are connected', async () => {
  await withRegistry(async (_manager, file) => {
    fs.writeFileSync(file, '{')
    const errors: Error[] = []
    const recovered = new TelemetrySourceManager(file, (error) => errors.push(error))
    assert.equal(errors.length, 1)
    assert.equal(recovered.snapshot().sources.length, 0)
  })
})
test('Xbox is independently detected and conflicting platform cannot relabel an active source', async () => {
  await withRegistry(async (manager) => {
    manager.observe(fixture(4), 'xbox', false)
    assert.equal(manager.captureProfile.platform, 'XBOX')
    const profile = manager.captureProfile
    assert.equal(manager.observe(fixture(1), 'xbox', true).accepted, false)
    assert.deepEqual(manager.captureProfile, profile)
  })
})
test('persistence failure reports an error without dropping accepted capture', async () => {
  await withRegistry(async (_manager, file) => {
    const errors: Error[] = []
    const blocked = new TelemetrySourceManager(path.join(file, 'sources.json'), (error) => errors.push(error))
    fs.writeFileSync(file, 'blocking parent file')
    assert.equal(blocked.observe(fixture(), 'console', false).accepted, true)
    await blocked.flush()
    assert.equal(blocked.captureProfile.platform, 'PLAYSTATION')
    assert.equal(errors.length, 1)
    assert.equal(fs.readFileSync(file, 'utf8'), 'blocking parent file')
  })
})
test('production packet filtering keeps conflicts out of accepted health/capture while preserving raw forwarding', () => {
  const health = new TelemetryHealth()
  health.onListening(20779, '0.0.0.0')
  const packet = Buffer.alloc(33)
  packet.writeUInt16LE(2025, 0); packet.writeUInt8(3, 6); packet.write('SSTA', 29)
  let forwarded = 0, captured = 0
  const result = processTelemetryDatagram(packet, { address: 'other', port: 1 }, {
    health, relay: () => forwarded++, acceptParsed: () => false, onParsed: () => captured++,
  })
  assert.equal(result, 'conflict')
  assert.equal(captured, 0); assert.equal(forwarded, 1)
  assert.equal(health.snapshot().validPacketsReceived, 0)
  health.stop()
})
