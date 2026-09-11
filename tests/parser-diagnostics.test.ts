import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIntentionallyIgnoredPacket, isSupportedPacketFormat } from '../src/udp/parser'
import { PACKET } from '../src/udp/packets/common'

test('packet support reflects native formats and explicit overrides', () => {
  assert.equal(isSupportedPacketFormat(2025), true)
  assert.equal(isSupportedPacketFormat(2026), false)
  assert.equal(isSupportedPacketFormat(2026, 'f1_2025'), true)
})

test('only deliberate parser omissions are treated as valid ignored packets', () => {
  assert.equal(isIntentionallyIgnoredPacket(PACKET.MOTION, 2025), true)
  assert.equal(isIntentionallyIgnoredPacket(PACKET.LOBBY_INFO, 2025), true)
  assert.equal(isIntentionallyIgnoredPacket(PACKET.TYRE_SETS, 2023), false)
  assert.equal(isIntentionallyIgnoredPacket(PACKET.CAR_STATUS, 2025), false)
  assert.equal(isIntentionallyIgnoredPacket(99, 2025), false)
})
