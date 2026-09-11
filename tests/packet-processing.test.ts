import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TelemetryHealth } from '../src/health/state'
import { processTelemetryDatagram } from '../src/udp/processPacket'
import { HEADER_SIZE, PACKET } from '../src/udp/packets/common'

function header(format: number, packetId: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE)
  buf.writeUInt16LE(format, 0)
  buf.writeUInt8(packetId, 6)
  buf.writeUInt32LE(0x12345678, 7)
  buf.writeUInt32LE(0x9abcdef0, 11)
  buf.writeUInt8(4, 27)
  return buf
}

function run(buf: Buffer) {
  const health = new TelemetryHealth()
  health.onListening(20779, '0.0.0.0')
  const relayed: Buffer[] = []
  const parsed: unknown[] = []
  const disposition = processTelemetryDatagram(buf, { address: '127.0.0.1', port: 52000 }, {
    health,
    relay: (packet) => relayed.push(Buffer.from(packet)),
    onParsed: (packet) => parsed.push(packet),
  })
  health.stop()
  return { disposition, snapshot: health.snapshot(), relayed, parsed }
}

test('production packet boundary rejects a malformed datagram without blocking raw relay', () => {
  const result = run(Buffer.from([1, 2, 3]))
  assert.equal(result.disposition, 'malformed')
  assert.equal(result.snapshot.state, 'LISTENING')
  assert.equal(result.snapshot.malformedPackets, 1)
  assert.equal(result.relayed.length, 1)
  assert.deepEqual(result.relayed[0], Buffer.from([1, 2, 3]))
})

test('production packet boundary reports unsupported F1 formats honestly', () => {
  const result = run(header(2026, PACKET.SESSION))
  assert.equal(result.disposition, 'unsupported')
  assert.equal(result.snapshot.state, 'LISTENING')
  assert.equal(result.snapshot.packetFormat, 2026)
  assert.equal(result.snapshot.unsupportedPackets, 1)
})

test('a supported intentionally ignored F1 packet is valid telemetry', () => {
  const result = run(header(2025, PACKET.MOTION))
  assert.equal(result.disposition, 'ignored')
  assert.equal(result.snapshot.state, 'RECEIVING')
  assert.equal(result.snapshot.sessionUid, '9abcdef012345678')
  assert.equal(result.snapshot.playerVehicleIndex, 4)
  assert.equal(result.parsed.length, 0)
})
