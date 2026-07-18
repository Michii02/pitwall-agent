/**
 * UDP socket setup and raw packet receiver.
 *
 * Binds receive-only on the configured port. Handles EADDRINUSE with a clear
 * error so the tray can surface "port in use" to the driver, and retries the
 * bind with capped backoff instead of giving up permanently — a port that's
 * busy now may free up (the other app closes, a previous agent instance
 * exits, etc.) without requiring the whole process to be restarted.
 */

import dgram from 'node:dgram'
import { execFile } from 'node:child_process'
import { log } from '../utils/logger'

export interface UdpListenerEvents {
  onPacket: (buf: Buffer) => void
  onBindError: (err: Error) => void
  onListening: (address: string, port: number) => void
  /** Another process holds a more-specific binding on our port and is
   *  consuming the game's packets (e.g. MOZA Pit House on 127.0.0.1). */
  onPortHijacked?: (byProcess: string) => void
}

export interface UdpListenerHandle {
  /** Stop retrying and close the current socket (if bound). Idempotent. */
  close(): void
}

// Capped exponential backoff between bind retries: 2s, 5s, 15s, 30s, then
// repeats at 30s. Resets to the start once a bind succeeds.
const RETRY_DELAYS_MS = [2000, 5000, 15_000, 30_000]

/**
 * Windows delivers a unicast UDP datagram to the socket with the most
 * specific binding. If another app is bound to 127.0.0.1:<port> while we
 * hold 0.0.0.0:<port>, it receives everything and we receive nothing —
 * silently. Detect that so the user gets a clear warning instead of
 * mysteriously missing sessions.
 */
export function detectPortConflict(port: number, cb: (processName: string | null) => void): void {
  if (process.platform !== 'win32') { cb(null); return }
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -ne '0.0.0.0' -and $_.OwningProcess -ne ${process.pid} } | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Select-Object -First 1`,
  ], { timeout: 15_000 }, (err, stdout) => {
    const name = (stdout ?? '').trim()
    cb(!err && name ? name : null)
  })
}

export function startUdpListener(
  port: number,
  bindAddress: string,
  events: UdpListenerEvents,
): UdpListenerHandle {
  let currentSocket: dgram.Socket | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let retryAttempt = 0
  let notifiedThisOutage = false // only surface onBindError once per outage, not on every retry
  let closed = false

  function bindOnce(): void {
    if (closed) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    currentSocket = socket
    let packetsReceived = 0
    let hijackWarned = false

    socket.on('message', (msg) => {
      packetsReceived++
      events.onPacket(msg as Buffer)
    })

    // Periodic hijack check: if we've received nothing while a more-specific
    // binding exists on our port, another app is eating the telemetry.
    const hijackTimer = setInterval(() => {
      if (packetsReceived > 0 || hijackWarned) return
      detectPortConflict(port, (processName) => {
        if (processName && packetsReceived === 0 && !hijackWarned) {
          hijackWarned = true
          log.warn(`"${processName}" is bound to 127.0.0.1:${port} and is consuming F1 telemetry — this agent receives nothing (` +
            `Windows delivers unicast UDP to only the most specific binding, so two apps can't both listen on the same port). ` +
            `Fix: reconfigure ${processName} to listen on a different port (e.g. 20778) instead of ${port}, keep F1 25's UDP ` +
            `output pointed at PitWall's port (${port}), and add "127.0.0.1:20778" to FORWARD_TARGETS in the PitWall Agent ` +
            `settings — PitWall will relay every packet to ${processName} so it keeps working unmodified.`)
          events.onPortHijacked?.(processName)
        }
      })
    }, 30_000)
    socket.on('close', () => clearInterval(hijackTimer))

    socket.on('listening', () => {
      retryAttempt = 0 // reset backoff after a successful bind
      notifiedThisOutage = false
      const a = socket.address()
      log.info(`UDP listener bound on ${a.address}:${a.port}`)
      events.onListening(a.address, a.port)
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`UDP port ${port} is in use by another application. ` +
          'Change the port in Settings or close the conflicting application.')
      } else {
        log.error(`UDP socket error: ${err.message}`)
      }
      if (!notifiedThisOutage) {
        notifiedThisOutage = true
        events.onBindError(err)
      }
      try { socket.close() } catch { /* already closed */ }
      currentSocket = null
      if (closed) return
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)]
      retryAttempt++
      log.info(`Retrying UDP bind on port ${port} in ${delay / 1000}s (attempt ${retryAttempt})…`)
      retryTimer = setTimeout(bindOnce, delay)
    })

    socket.bind(port, bindAddress)
  }

  bindOnce()

  return {
    close(): void {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      try { currentSocket?.close() } catch { /* already closed */ }
    },
  }
}
