import { once } from 'node:events'
import dgram from 'node:dgram'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPortConflict, startUdpListener } from '../src/udp/listener'

async function reservePort(): Promise<{ socket: dgram.Socket; port: number }> {
  const socket = dgram.createSocket('udp4')
  socket.bind(0, '127.0.0.1')
  await once(socket, 'listening')
  const address = socket.address()
  assert.equal(typeof address, 'object')
  return { socket, port: address.port }
}

function send(port: number, payload = Buffer.from([1, 2, 3])): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.send(payload, port, '127.0.0.1', (error) => {
      socket.close()
      if (error) reject(error)
      else resolve()
    })
  })
}

test('listener reports source metadata and receives only its configured port', async () => {
  let received: { data: Buffer; source: { address: string; port: number } } | null = null
  let listeningPort = 0
  let resolveListening!: () => void
  const listening = new Promise<void>((resolve) => { resolveListening = resolve })
  const listener = startUdpListener(0, '127.0.0.1', {
    onPacket: (data, source) => { received = { data, source } },
    onBindError: (error) => { throw error },
    onListening: (_address, port) => { listeningPort = port; resolveListening() },
  })
  await listening

  await send(listeningPort + 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(received, null)

  await send(listeningPort, Buffer.from([9, 8, 7]))
  for (let i = 0; i < 20 && !received; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(received)
  assert.deepEqual(received.data, Buffer.from([9, 8, 7]))
  assert.equal(received.source.address, '127.0.0.1')
  assert.ok(received.source.port > 0)
  listener.close()
})

test('listener can stop and bind the same port again during idle', async () => {
  const reservation = await reservePort()
  const port = reservation.port
  reservation.socket.close()
  await once(reservation.socket, 'close')

  const start = () => new Promise<ReturnType<typeof startUdpListener>>((resolve, reject) => {
    let handle: ReturnType<typeof startUdpListener>
    handle = startUdpListener(port, '127.0.0.1', {
      onPacket: () => {},
      onBindError: reject,
      onListening: () => resolve(handle),
    })
  })
  const first = await start()
  first.close()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = await start()
  second.close()
})

test('specific-address port conflicts are detected', async () => {
  const reservation = await reservePort()
  const conflict = await new Promise<boolean>((resolve) => detectPortConflict(reservation.port, resolve))
  assert.equal(conflict, true)
  reservation.socket.close()
})
