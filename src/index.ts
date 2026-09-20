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
import { processTelemetryDatagram } from './udp/processPacket'
import { SessionLifecycle } from './session/lifecycle'
import { SessionQueue } from './sync/queue'
import { SyncSender } from './sync/sender'
import { LiveForwarder } from './sync/live'
import { TrayManager, openLogsInNotepad, openSettingsFile } from './tray/icon'
import type { GameVersion } from './udp/packets/common'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { TelemetrySourceManager } from './sources/manager'

const AGENT_VERSION = '1.0.2'
const ERROR_STATE_AFTER_MS = 30 * 60_000
const QUEUE_WARNING_THRESHOLD = 50

async function main(): Promise<void> {
  const config = loadConfig()
  const sources = new TelemetrySourceManager(path.join(APP_DIR, 'known-sources.json'), (error) => log.warn(`Source configuration could not be saved: ${error.message}`))
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
  const ownerFingerprint = createHash('sha256').update(config.agentToken).digest('hex')
  let recovery = queue.loadActiveCheckpoint()
  if (recovery && recovery.ownerFingerprint !== ownerFingerprint) {
    queue.quarantineActiveCheckpoint(recovery.collector.record.id, 'Pairing owner changed')
    log.warn('Previous active capture belongs to a different pairing; retained locally')
    recovery = null
  }

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
    canFinishInterruptedCapture: () => lifecycle.canFinishInterruptedCapture,
    onFinishInterruptedCapture: () => lifecycle.finishInterruptedCapture(),
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
    onCaptureFinalized: (record) => queue.completeActiveSession(record),
    onCheckpoint: () => {
      tray.setState(lifecycle.currentState) // refresh the interrupted-session action
      const address = sources.senderAddress
      if (!address) return
      const checkpoint = lifecycle.createCheckpoint(address, ownerFingerprint)
      if (checkpoint) {
        try { queue.saveActiveCheckpoint(checkpoint) }
        catch (error) { log.warn(`Active capture could not be checkpointed: ${(error as Error).message}`) }
      }
    },
    onLapComplete: () => {
      tray.setState('SESSION_ACTIVE') // refreshes "Lap N" in menu
      live.pushSnapshot()
    },
  }, {
    // Capture provenance (League Session Intelligence MVP 1.1). The capture
    // path is identical for PC and console — this only labels the session.
    ...sources.captureProfile,
  })

  const versionOverride: GameVersion | undefined =
    config.gameVersion === 'auto' ? undefined : config.gameVersion

  // Telemetry relay to other UDP tools (Moza Pit House, SimHub, …). Keep it
  // before the health payload factory so every push includes current target
  // counters and errors.
  const relayTargets = parseRelayTargets(config.forwardTargets)
  const relay = new TelemetryRelay(relayTargets)

  // Live-view relay to the PitWall server WS (display only; persistence is udp-ingest)
  // MVP1 Phase 1f: network interfaces + the configured capture platform are
  // composed onto every health push here, at the boundary — health/state.ts
  // itself stays driven only by real UDP signals (see network/interfaces.ts).
  const buildHealthPushPayload = () => ({
    ...telemetryHealth.snapshot(),
    network: detectAgentNetworkInfo(),
    capturePlatform: config.capturePlatform,
    sources: sources.snapshot(),
    recording: lifecycle.snapshot,
    forwarding: relay.snapshot(),
    queueDepth: queue.pendingCount(),
  })
  const live = new LiveForwarder(config, () => lifecycle.snapshot, buildHealthPushPayload)
  live.start()
  telemetryHealth.onStateChange(() => live.pushHealth(buildHealthPushPayload()))

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
    onPacket: (buf, source) => {
      processTelemetryDatagram(buf, source, {
        health: telemetryHealth,
        versionOverride,
        relay: (packet) => relay.forward(packet),
        acceptIgnored: (header) => sources.acceptsAuxiliaryPacket(header.sessionUid, source.address, lifecycle.snapshot.active),
        acceptParsed: (result) => {
          if (recovery && result.packet.kind !== 'session') return false
          const decision = sources.observe(result, source.address, lifecycle.snapshot.active,
            config.capturePlatformOverride ? config.capturePlatform : undefined, Date.now(), versionOverride !== undefined)
          if (!decision.accepted) return false
          if (recovery) {
            lifecycle.restoreRecovery(recovery, result, source.address)
            recovery = null
          }
          if (decision.transition) lifecycle.resetForSourceTransition()
          lifecycle.updateCaptureProfile(sources.captureProfile)
          return true
        },
        onParsed: (result) => {
          lifecycle.feed(result)
          live.forward(result)
          overlayBridge.forward(result)
        },
        onError: (err) => log.error(`Packet handling error: ${err.message}`),
      })
    },
    onBindError: () => {
      telemetryHealth.onBindError()
      tray.setState('ERROR')
      tray.notify('UDP port in use',
        `UDP port ${config.udpPort} is in use by another application. Change the port in Settings, or point that ` +
        'application at a different port and add it to FORWARD_TARGETS so PitWall relays telemetry to it.')
    },
    onPortHijacked: () => {
      telemetryHealth.onPortHijacked()
      tray.setState('ERROR')
      tray.notify('Telemetry blocked by another app',
        `Another application is consuming F1 telemetry on port ${config.udpPort}. Reconfigure it to use a different ` +
        'port and add it to FORWARD_TARGETS in agent settings — PitWall will relay telemetry to it.')
    },
    onListening: (address, port) => {
      telemetryHealth.onListening(port, address)
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
    try { sender.stop() } catch { /* ok */ }
    try { lifecycle.stop() } catch { /* ok */ }
    try { queue.close() } catch { /* ok */ }
    telemetryHealth.stop()
    releaseInstanceLock()
    void sources.flush().finally(() => process.exit(code))
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}\n${err.stack}`)
  })
}

void main()
