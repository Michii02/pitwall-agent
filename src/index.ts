/**
 * PitWall UDP Agent — entry point.
 *
 * Boots config → logger → queue → sync → lifecycle → UDP listener → tray.
 * Runs silently in the background; the tray icon is the only UI.
 */

import { loadConfig, APP_DIR } from './config'
import { configureLogger, log } from './utils/logger'
import { acquireInstanceLock, releaseInstanceLock } from './instance-lock'
import { telemetryHealth } from './health/state'
import { detectAgentNetworkInfo } from './network/interfaces'
import { startUdpListener } from './udp/listener'
import { parseRelayTargets, TelemetryRelay } from './udp/relay'
import { OverlayBridge } from './overlay/localBridge'
import { startOverlayPreferencePoll } from './overlay/preferencePoll'
import { parsePacket, parseHeader } from './udp/parser'
import { SessionLifecycle } from './session/lifecycle'
import { SessionQueue } from './sync/queue'
import { SyncSender } from './sync/sender'
import { LiveForwarder } from './sync/live'
import { TrayManager, openLogsInNotepad, openSettingsFile } from './tray/icon'
import type { GameVersion } from './udp/packets/common'

const AGENT_VERSION = '1.0.1'
const ERROR_STATE_AFTER_MS = 30 * 60_000
const QUEUE_WARNING_THRESHOLD = 50

async function main(): Promise<void> {
  const config = loadConfig()
  configureLogger({ level: config.logLevel, maxSizeMb: config.logMaxSizeMb, maxFiles: config.logMaxFiles })

  log.info(`PitWall Agent v${AGENT_VERSION} starting · API ${config.apiUrl} · UDP ${config.udpBindAddress}:${config.udpPort}`)
  log.info(`Config dir: ${APP_DIR} · relay → [${config.forwardTargets || 'none'}]`)

  // Must happen before anything opens the UDP socket — see instance-lock.ts
  // for why a second live instance must never be allowed to proceed.
  const lock = acquireInstanceLock()
  if (!lock.acquired) {
    log.info(`Another PitWall Agent instance is already running (PID ${lock.heldByPid}) — exiting quietly, the running instance is undisturbed.`)
    process.exit(0)
  }

  if (config.firstRun) {
    log.warn(`First run — no .env found at ${APP_DIR}, created one with defaults (UDP ${config.udpPort}). ` +
      'If this is unexpected, the agent was launched without access to your normal config folder.')
  }

  const queue = new SessionQueue()

  let firstSyncNotified = false
  const tray = new TrayManager({
    onSyncNow: () => { void sender.syncNow() },
    onOpenLogs: openLogsInNotepad,
    onOpenSettings: openSettingsFile,
    onQuit: () => {
      log.info('Quit requested from tray')
      shutdown(0)
    },
    getPendingCount: () => queue.pendingCount(),
    getSessionDetail: () => lifecycle.sessionDetail,
  }, AGENT_VERSION)

  const sender = new SyncSender(queue, config, {
    onSyncSuccess: () => {
      if (!firstSyncNotified) {
        firstSyncNotified = true
        tray.notify('PitWall Agent connected', 'Sessions will now sync automatically.')
      }
      tray.setState('SYNCED')
      setTimeout(() => tray.setState(lifecycle.currentState), 5000)
    },
    onSyncFailure: () => {
      const failingFor = sender.failingSince ? Date.now() - sender.failingSince : 0
      if (failingFor > ERROR_STATE_AFTER_MS) {
        tray.setState('ERROR')
        tray.notify('PitWall Agent cannot reach the server', 'Check your connection or API settings.')
      } else {
        tray.setState('WARNING')
      }
      if (queue.pendingCount() >= QUEUE_WARNING_THRESHOLD) {
        tray.notify(`${QUEUE_WARNING_THRESHOLD} sessions queued`, 'Connect to internet to sync.')
      }
    },
    onQueueDrained: () => tray.setState(lifecycle.currentState),
    onConflict: (_id, trackName) => {
      tray.notify('Session conflict detected', `Session conflict at ${trackName} — review in PitWall.`)
    },
  })

  const lifecycle = new SessionLifecycle({
    onStateChange: (state) => {
      tray.setState(state)
      live.pushSnapshot()
    },
    onSessionComplete: (record) => sender.submit(record),
    onLapComplete: () => {
      tray.setState('SESSION_ACTIVE') // refreshes "Lap N" in menu
      live.pushSnapshot()
    },
  }, {
    // Capture provenance (League Session Intelligence MVP 1.1). The capture
    // path is identical for PC and console — this only labels the session.
    platform: config.capturePlatform,
    captureMethod: config.capturePlatform === 'PC' ? 'PC_NATIVE' : 'CONSOLE_DESKTOP',
  })

  const versionOverride: GameVersion | undefined =
    config.gameVersion === 'auto' ? undefined : config.gameVersion

  // Live-view relay to the PitWall server WS (display only; persistence is udp-ingest)
  // MVP1 Phase 1f: network interfaces + the configured capture platform are
  // composed onto every health push here, at the boundary — health/state.ts
  // itself stays driven only by real UDP signals (see network/interfaces.ts).
  const buildHealthPushPayload = () => ({
    ...telemetryHealth.snapshot(),
    network: detectAgentNetworkInfo(),
    capturePlatform: config.capturePlatform,
  })
  const live = new LiveForwarder(config, () => lifecycle.snapshot, buildHealthPushPayload)
  live.start()
  telemetryHealth.onStateChange(() => live.pushHealth(buildHealthPushPayload()))

  // Telemetry relay to other UDP tools (Moza Pit House, SimHub, …). F1 only
  // sends to one target, so this agent must be that exclusive target and
  // fan every raw packet back out — see udp/relay.ts for why.
  const relayTargets = parseRelayTargets(config.forwardTargets)
  const relay = new TelemetryRelay(relayTargets)

  // Local-only bridge for same-machine consumers (e.g. the input-trace
  // overlay) to subscribe to already-parsed telemetry. Best-effort — see
  // overlay/localBridge.ts.
  const overlayBridge = new OverlayBridge(config.overlayBridgePort, config.overlayBridgeEnabled)
  // Settings-page enable/disable, layered on top of the local master switch
  // above — only polls at all when that switch permits the bridge to run.
  const stopOverlayPoll = config.overlayBridgeEnabled
    ? startOverlayPreferencePoll(config.apiUrl, config.agentToken, overlayBridge)
    : () => {}

  const socket = startUdpListener(config.udpPort, config.udpBindAddress, {
    onPacket: (buf) => {
      // Header-only parse (cheap, works even for unsupported formats like a
      // "2026 Season Pack" packet that parsePacket() below would discard) so
      // health reporting always knows the real format in use, not just
      // whichever ones PitWall currently understands.
      telemetryHealth.onPacket(parseHeader(buf)?.packetFormat)
      // Relay the raw, unparsed bytes immediately — downstream tools get an
      // identical copy regardless of whether PitWall understands the packet.
      relay.forward(buf)
      try {
        const result = parsePacket(buf, versionOverride)
        if (result) {
          lifecycle.feed(result)
          live.forward(result)
          overlayBridge.forward(result)
        }
      } catch (err) {
        log.error(`Packet handling error: ${(err as Error).message}`)
      }
    },
    onBindError: () => {
      telemetryHealth.onBindError()
      tray.setState('ERROR')
      tray.notify('UDP port in use',
        `UDP port ${config.udpPort} is in use by another application. Change the port in Settings, or point that ` +
        'application at a different port and add it to FORWARD_TARGETS so PitWall relays telemetry to it.')
    },
    onPortHijacked: (byProcess) => {
      telemetryHealth.onPortHijacked()
      tray.setState('ERROR')
      tray.notify('Telemetry blocked by another app',
        `${byProcess} is consuming F1 telemetry on port ${config.udpPort}. Reconfigure ${byProcess} to use a different ` +
        'port and add it to FORWARD_TARGETS in agent settings — PitWall will relay telemetry to it.')
    },
    onListening: (address, port) => {
      telemetryHealth.onListening(port)
      tray.setState('IDLE')
    },
  })

  await tray.start()

  // Drain any sessions queued from a previous run
  if (queue.pendingCount() > 0) {
    log.info(`${queue.pendingCount()} session(s) queued from previous run — attempting sync`)
    void sender.syncNow()
  }

  function shutdown(code: number): void {
    log.info('PitWall Agent shutting down')
    try { live.stop() } catch { /* ok */ }
    try { relay.close() } catch { /* ok */ }
    try { stopOverlayPoll() } catch { /* ok */ }
    try { overlayBridge.close() } catch { /* ok */ }
    try { socket.close() } catch { /* ok */ }
    try { queue.close() } catch { /* ok */ }
    telemetryHealth.stop()
    releaseInstanceLock()
    process.exit(code)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}\n${err.stack}`)
  })
}

void main()
