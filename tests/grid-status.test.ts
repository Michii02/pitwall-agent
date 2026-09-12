import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePacket } from '../src/udp/parser'
import { HEADER_SIZE, PACKET } from '../src/udp/packets/common'

function packet(packetId: number, structSize: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + 22 * structSize)
  buf.writeUInt16LE(2025, 0)
  buf.writeUInt8(packetId, 6)
  buf.writeUInt8(3, 27)
  return buf
}

test('car-status parser exposes verified tyre and flag fields for the whole grid', () => {
  const size = 55
  const buf = packet(PACKET.CAR_STATUS, size)
  const base = HEADER_SIZE + 7 * size
  buf.writeFloatLE(17.25, base + 5)
  buf.writeUInt8(16, base + 25)
  buf.writeUInt8(16, base + 26)
  buf.writeUInt8(4, base + 27)
  buf.writeInt8(1, base + 28)
  const parsed = parsePacket(buf)
  assert.equal(parsed?.packet.kind, 'status')
  if (parsed?.packet.kind !== 'status') return
  assert.deepEqual(parsed.packet.grid?.[7], {
    vehicleIndex: 7, fuelInTank: 17.25, actualTyreCompound: 16,
    visualTyreCompound: 16, tyresAgeLaps: 4, vehicleFiaFlags: 1,
  })
})

test('lap parser exposes penalty seconds for player and grid cars', () => {
  const size = 57
  const buf = packet(PACKET.LAP_DATA, size)
  const playerBase = HEADER_SIZE + 3 * size
  const rivalBase = HEADER_SIZE + 7 * size
  buf.writeUInt8(3, playerBase + 38)
  buf.writeUInt8(5, rivalBase + 38)
  const parsed = parsePacket(buf)
  assert.equal(parsed?.packet.kind, 'lap')
  if (parsed?.packet.kind !== 'lap') return
  assert.equal(parsed.packet.penaltiesSeconds, 3)
  assert.equal(parsed.packet.grid?.[7].penaltiesSeconds, 5)
})
