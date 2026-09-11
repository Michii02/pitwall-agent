/**
 * HTTP sync to the PitWall API with exponential-backoff retries.
 *
 * Retry schedule after a failure: 30 s → 2 min → 10 min → 30 min → every
 * 60 min indefinitely. Every schedule tick retries ALL pending sessions,
 * oldest first, so an extended outage drains in order when connectivity
 * returns.
 */

import { SessionQueue } from './queue'
import type { SessionRecord } from '../session/collector'
import type { AgentConfig } from '../config'
import { log } from '../utils/logger'

const RETRY_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000]
const AGENT_VERSION = process.env.npm_package_version ?? '1.0.0'

export interface SenderEvents {
  onSyncSuccess: (sessionId: string) => void
  onSyncFailure: (sessionId: string, error: string) => void
  onQueueDrained: () => void
  onConflict: (sessionId: string, trackName: string) => void
}

export class SyncSender {
  private retryIndex = 0
  private retryTimer: NodeJS.Timeout | null = null
  private syncing = false
  /** Timestamp of the first failure in the current failing streak (for the 30-min error state). */
  failingSince: number | null = null

  constructor(
    private queue: SessionQueue,
    private config: AgentConfig,
    private events: SenderEvents,
  ) {}

  /** Called when a session completes — persist and attempt immediate sync. */
  async submit(record: SessionRecord): Promise<void> {
    this.queue.upsert(record, 'complete')
    await this.syncAll()
  }

  /** Manual "Sync now" from the tray — resets backoff and tries immediately. */
  async syncNow(): Promise<void> {
    this.retryIndex = 0
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    await this.syncAll()
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private async syncAll(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      const pending = this.queue.pendingSessions()
      let anyFailure = false

      for (const { id, record } of pending) {
        const outcome = await this.postSession(record)
        this.queue.logSyncAttempt(id, outcome.status, outcome.error)

        if (outcome.status === 'synced' || outcome.status === 'duplicate') {
          this.queue.setStatus(id, 'synced')
          this.failingSince = null
          log.info(`Sync · ${outcome.status} · session ${id}`)
          this.events.onSyncSuccess(id)
          if (outcome.conflict) this.events.onConflict(id, record.track_name)
        } else if (outcome.status === 'invalid') {
          // 422 — permanent failure, do not retry
          this.queue.setStatus(id, 'failed')
          log.error(`Sync · validation failed · session ${id} · ${outcome.error}`)
          this.events.onSyncFailure(id, outcome.error ?? 'validation failed')
        } else {
          // transient failure — leave queued for retry
          this.queue.setStatus(id, 'queued')
          anyFailure = true
          if (this.failingSince === null) this.failingSince = Date.now()
          log.warn(`Sync · failed (will retry) · session ${id} · ${outcome.error}`)
          this.events.onSyncFailure(id, outcome.error ?? 'network error')
        }
      }

      if (anyFailure) {
        this.scheduleRetry()
      } else {
        this.retryIndex = 0
        if (this.queue.pendingCount() === 0) this.events.onQueueDrained()
      }
    } finally {
      this.syncing = false
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = RETRY_STEPS_MS[Math.min(this.retryIndex, RETRY_STEPS_MS.length - 1)]
    this.retryIndex++
    log.info(`Sync retry scheduled in ${Math.round(delay / 1000)}s`)
    this.retryTimer = setTimeout(() => { void this.syncAll() }, delay)
  }

  private async postSession(record: SessionRecord): Promise<{
    status: 'synced' | 'duplicate' | 'invalid' | 'error'
    error?: string
    conflict?: boolean
  }> {
    try {
      const res = await fetch(`${this.config.apiUrl}/api/sessions/udp-ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.agentToken ? { Authorization: `Bearer ${this.config.agentToken}` } : {}),
          'X-Agent-Version': AGENT_VERSION,
          'X-Game-Version': record.game_version,
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(30_000),
      })

      if (res.status === 201) {
        let conflict = false
        try {
          const data = (await res.json()) as { conflict?: boolean }
          conflict = !!data?.conflict
        } catch { /* no body */ }
        return { status: 'synced', conflict }
      }
      if (res.status === 409) return { status: 'duplicate' }
      if (res.status === 422) {
        const body = await res.text().catch(() => '')
        return { status: 'invalid', error: `422: ${body.slice(0, 300)}` }
      }
      return { status: 'error', error: `HTTP ${res.status}` }
    } catch (err) {
      return { status: 'error', error: (err as Error).message }
    }
  }
}
