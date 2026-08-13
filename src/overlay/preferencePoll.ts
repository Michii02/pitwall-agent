/**
 * Polls the driver's per-account Settings-page toggle for the Input Trace
 * Overlay and applies it to a running OverlayBridge. Only started when the
 * local .env master switch (OVERLAY_BRIDGE_ENABLED) is on — that stays the
 * hard local override; this poll can only turn the bridge off/on within
 * whatever that local switch already allows.
 */

import { log } from '../utils/logger'
import type { OverlayBridge } from './localBridge'

const POLL_INTERVAL_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000

export function startOverlayPreferencePoll(
  apiUrl: string,
  agentToken: string,
  bridge: OverlayBridge,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null

  async function pollOnce(): Promise<void> {
    if (!agentToken) return // never paired — nothing to poll for yet
    try {
      const res = await fetch(`${apiUrl}/api/agent/overlay/preference`, {
        headers: { Authorization: `Bearer ${agentToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) return
      const data = (await res.json()) as { enabled?: boolean }
      // Default to enabled on a malformed/missing field — matches the
      // server's own default-true preference semantics.
      bridge.setEnabled(data.enabled !== false)
    } catch (err) {
      log.debug(`Overlay preference poll failed: ${(err as Error).message}`)
    }
  }

  void pollOnce()
  timer = setInterval(() => { void pollOnce() }, POLL_INTERVAL_MS)

  return function stop(): void {
    if (timer) clearInterval(timer)
  }
}
