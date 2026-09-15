import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ParseResult } from '../udp/parser'
import type { CaptureProfile } from '../session/collector'

type Platform = CaptureProfile['platform']
interface KnownSource {
  sourceId: string
  name: string
  platform: Exclude<Platform, 'UNKNOWN'>
  configurationStatus: 'configured'
  lastSeenAt: number | null
}
/** V1 remembers one logical connection profile per platform, not hardware serial identity. */
export class TelemetrySourceManager {
  private sources: KnownSource[] = []
  private seen = new Map<string, number>()
  private sourceStates = new Map<string, 'receiving' | 'conflict'>()
  private activeAddress: string | null = null
  private activeUid: string | null = null
  private activeSourceId: string | null = null
  private retiredUids: string[] = []
  private conflictCount = 0
  private lastSavedAt = 0
  private persistence: Promise<void> = Promise.resolve()
  private current: CaptureProfile = { platform: 'UNKNOWN', captureMethod: null, platformOrigin: 'unknown', sourceDeviceId: null }

  constructor(private file: string, private onError: (error: Error) => void = () => {}) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1) throw new Error('Unsupported source registry')
      const records = (data as { sources?: unknown }).sources
      if (!Array.isArray(records) || records.length > 3) throw new Error('Invalid source registry')
      const ids = new Set<string>(), platforms = new Set<string>()
      this.sources = records.map((record) => {
        if (!record || typeof record !== 'object' ||
          typeof record.sourceId !== 'string' || !record.sourceId || record.sourceId.length > 128 ||
          typeof record.name !== 'string' || !record.name || record.name.length > 80 ||
          !['PC', 'PLAYSTATION', 'XBOX'].includes(record.platform) ||
          record.configurationStatus !== 'configured' || ids.has(record.sourceId) || platforms.has(record.platform) ||
          (record.lastSeenAt !== null && (!Number.isFinite(record.lastSeenAt) || record.lastSeenAt < 0))) throw new Error('Invalid known source')
        ids.add(record.sourceId); platforms.add(record.platform)
        return { sourceId: record.sourceId, name: record.name, platform: record.platform, configurationStatus: 'configured', lastSeenAt: record.lastSeenAt }
      })
    } catch (error) {
      this.sources = []
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error as Error)
    }
  }

  get captureProfile(): CaptureProfile { return { ...this.current } }

  observe(result: ParseResult, address: string, activeSession: boolean, override?: Platform, now = Date.now(), layoutOverride = false): { accepted: boolean; transition: boolean } {
    const uid = result.header.sessionUid
    if (this.retiredUids.includes(uid)) return { accepted: false, transition: false }
    let platform: Platform = override ?? 'UNKNOWN'
    let origin: CaptureProfile['platformOrigin'] = override && override !== 'UNKNOWN' ? 'user_selected' : 'unknown'
    if (!override && !layoutOverride && result.header.packetFormat === 2025 && result.gameVersion === 'f1_2025' && result.packet.kind === 'participant') {
      const index = result.header.playerCarIndex
      const code = Number.isInteger(index) && index >= 0 && index < 22
        ? result.packet.grid?.find((entry) => entry.vehicleIndex === index)?.platform : null
      platform = code === 1 || code === 6 ? 'PC' : code === 3 ? 'PLAYSTATION' : code === 4 ? 'XBOX' : 'UNKNOWN'
      origin = platform === 'UNKNOWN' ? 'unknown' : 'detected'
    }
    if (activeSession && this.activeAddress !== null && address !== this.activeAddress) {
      this.conflictCount = Math.min(Number.MAX_SAFE_INTEGER, this.conflictCount + 1)
      return { accepted: false, transition: false }
    }
    if (activeSession && origin === 'detected' && this.current.platform !== 'UNKNOWN' && platform !== 'UNKNOWN' &&
      platform !== this.current.platform && this.activeUid === uid) {
      this.conflictCount = Math.min(Number.MAX_SAFE_INTEGER, this.conflictCount + 1)
      return { accepted: false, transition: false }
    }
    const changed = this.activeAddress !== null && (this.activeAddress !== address || this.activeUid !== uid)
    if (changed && this.activeUid === uid) return { accepted: false, transition: false }
    // Never start a new source using the previous source's cached Session packet.
    if (changed && (result.packet.kind !== 'session' || result.packet.sessionType === 0 || result.packet.trackId < 0)) {
      return { accepted: false, transition: false }
    }
    if (changed) {
      if (this.activeUid) this.retiredUids = [...this.retiredUids.slice(-15), this.activeUid]
      this.current = { platform: 'UNKNOWN', captureMethod: null, platformOrigin: 'unknown', sourceDeviceId: null }
      this.activeSourceId = null
    }
    const known = platform === 'UNKNOWN' ? null : this.remember(platform, now)
    if (known) {
      this.seen.set(known.sourceId, now)
      this.sourceStates.set(known.sourceId, 'receiving')
    }
    this.activeAddress = address
    this.activeUid = uid
    if (known) {
      this.activeSourceId = known.sourceId
      this.current = { platform: known.platform, captureMethod: known.platform === 'PC' ? 'PC_NATIVE' : 'CONSOLE_DESKTOP', platformOrigin: origin, sourceDeviceId: known.sourceId }
    }
    if (this.activeSourceId) {
      this.seen.set(this.activeSourceId, now)
      const active = this.sources.find((source) => source.sourceId === this.activeSourceId)
      if (active) active.lastSeenAt = now
    }
    return { accepted: true, transition: changed }
  }

  acceptsAuxiliaryPacket(uid: string, address: string, activeSession: boolean): boolean {
    return !this.retiredUids.includes(uid) && (!activeSession ||
      (this.activeAddress === address && this.activeUid === uid))
  }

  snapshot(now = Date.now()) {
    return {
      activeSourceId: this.activeSourceId,
      sources: this.sources.map((source) => {
        const last = this.seen.get(source.sourceId)
        const age = last === undefined ? Infinity : Math.max(0, now - last)
        const state = age > 10_000 ? 'offline' : age > 4_000 ? 'interrupted' : this.sourceStates.get(source.sourceId) ?? 'offline'
        return { ...source, state }
      }),
      conflictCount: this.conflictCount,
    }
  }

  private remember(platform: Exclude<Platform, 'UNKNOWN'>, now: number): KnownSource {
    let source = this.sources.find((record) => record.platform === platform)
    const created = !source
    if (!source) {
      source = { sourceId: randomUUID(), name: platform === 'PLAYSTATION' ? 'PlayStation source' : platform === 'XBOX' ? 'Xbox source' : 'PC source', platform, configurationStatus: 'configured', lastSeenAt: now }
      this.sources.push(source)
    }
    source.lastSeenAt = now
    if (created || now - this.lastSavedAt > 30_000) {
      this.lastSavedAt = now
      const serialized = JSON.stringify({ version: 1, sources: this.sources })
      this.persistence = this.persistence.then(async () => {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
        const temporary = `${this.file}.tmp`
        await fs.promises.writeFile(temporary, serialized, { mode: 0o600 })
        await fs.promises.rename(temporary, this.file)
      }).catch((error: Error) => this.onError(error))
    }
    return source
  }

  async flush(): Promise<void> { await this.persistence }
}
