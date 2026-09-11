import { once } from 'node:events'
import dgram from 'node:dgram'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRelayTargets, TelemetryRelay } from '../src/udp/relay'

test('relay target parser ignores invalid entries and preserves valid targets', () => {
  assert.deepEqual(parseRelayTargets('Moza=127.0.0.1:20777, !SimHub=127.0.0.1:20779, broken, localhost:70000'), [
    { host: '127.0.0.1', port: 20777, name: 'Moza', enabled: true },
    { host: '127.0.0.1', port: 20779, name: 'SimHub', enabled: false },
  ])
})

test('relay forwards bytes unchanged and records per-target success', async () => {
  const receiver = dgram.createSocket('udp4')
  receiver.bind(0, '127.0.0.1')
  await once(receiver, 'listening')
  const address = receiver.address()
  assert.equal(typeof address, 'object')

  const relay = new TelemetryRelay([{ host: '127.0.0.1', port: address.port, name: 'Test receiver' }])
  const payload = Buffer.from([1, 2, 3, 4, 5])
  const received = once(receiver, 'message')
  relay.forward(payload)
  const [message] = await received
  assert.deepEqual(message, payload)

  await new Promise((resolve) => setTimeout(resolve, 10))
  const snapshot = relay.snapshot()
  assert.equal(snapshot.active, true)
  assert.equal(snapshot.totalPacketsForwarded, 1)
  assert.equal(snapshot.targets[0].packetsForwarded, 1)
  assert.ok(snapshot.targets[0].lastSuccessfulSendAt)
  assert.equal(snapshot.targets[0].lastError, null)

  relay.close()
  receiver.close()
})

test('relay fans one packet out to multiple enabled targets', async () => {
  const first = dgram.createSocket('udp4')
  const second = dgram.createSocket('udp4')
  first.bind(0, '127.0.0.1')
  second.bind(0, '127.0.0.1')
  await Promise.all([once(first, 'listening'), once(second, 'listening')])
  const firstAddress = first.address()
  const secondAddress = second.address()
  assert.equal(typeof firstAddress, 'object')
  assert.equal(typeof secondAddress, 'object')

  const relay = new TelemetryRelay([
    { host: '127.0.0.1', port: firstAddress.port, name: 'First' },
    { host: '127.0.0.1', port: secondAddress.port, name: 'Second' },
  ])
  const firstMessage = once(first, 'message')
  const secondMessage = once(second, 'message')
  relay.forward(Buffer.from('pitwall'))
  const [[firstPayload], [secondPayload]] = await Promise.all([firstMessage, secondMessage])
  assert.equal(firstPayload.toString(), 'pitwall')
  assert.equal(secondPayload.toString(), 'pitwall')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(relay.snapshot().targets.map((target) => target.packetsForwarded), [1, 1])

  relay.close()
  first.close()
  second.close()
})

test('disabled forwarding targets receive no packets and report disabled', async () => {
  const receiver = dgram.createSocket('udp4')
  receiver.bind(0, '127.0.0.1')
  await once(receiver, 'listening')
  const address = receiver.address()
  assert.equal(typeof address, 'object')
  let received = false
  receiver.on('message', () => { received = true })
  const relay = new TelemetryRelay([{ host: '127.0.0.1', port: address.port, enabled: false }])
  relay.forward(Buffer.from('disabled'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(received, false)
  assert.equal(relay.snapshot().active, false)
  assert.equal(relay.snapshot().targets[0].enabled, false)
  relay.close()
  receiver.close()
})

test('an unavailable forwarding target records its send error without throwing', async () => {
  const relay = new TelemetryRelay([{ host: 'unavailable.invalid', port: 20780, name: 'Unavailable' }])
  assert.doesNotThrow(() => relay.forward(Buffer.from('packet')))
  for (let i = 0; i < 100 && relay.snapshot().targets[0].errorCount === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const target = relay.snapshot().targets[0]
  assert.equal(target.packetsForwarded, 0)
  assert.equal(target.errorCount, 1)
  assert.ok(target.lastError)
  relay.close()
})
