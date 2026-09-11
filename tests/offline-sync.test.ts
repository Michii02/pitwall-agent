import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentConfig } from '../src/config'
import type { SessionRecord } from '../src/session/collector'
import { SessionQueue } from '../src/sync/queue'
import { SyncSender } from '../src/sync/sender'

test('an offline sync leaves the session durable across an app restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-offline-'))
  const dbPath = path.join(directory, 'agent.db')
  const queue = new SessionQueue(dbPath)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('network unavailable') }

  const config = {
    apiUrl: 'http://127.0.0.1:1', agentToken: 'test-token', udpPort: 20779,
    udpBindAddress: '0.0.0.0', capturePlatform: 'PC', gameVersion: 'auto',
    logLevel: 'error', logMaxSizeMb: 1, logMaxFiles: 1, firstRun: false,
    forwardTargets: '', overlayBridgeEnabled: false, overlayBridgePort: 20780,
  } satisfies AgentConfig
  const sender = new SyncSender(queue, config, {
    onSyncSuccess: () => {}, onSyncFailure: () => {}, onQueueDrained: () => {}, onConflict: () => {},
  })
  const record = { id: 'offline-session', track_name: 'Test Track', game_version: 'f1_2025' } as SessionRecord

  try {
    await sender.submit(record)
    assert.equal(queue.pendingCount(), 1)
    sender.stop()
    queue.close()

    const afterRestart = new SessionQueue(dbPath)
    assert.equal(afterRestart.pendingCount(), 1)
    assert.equal(afterRestart.pendingSessions()[0].record.id, 'offline-session')
    afterRestart.close()
  } finally {
    sender.stop()
    globalThis.fetch = originalFetch
    try { queue.close() } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
