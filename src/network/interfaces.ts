import os from 'node:os'

// MVP1 Phase 1f — Console onboarding. Mirrors pitwall/server/routes/network.ts's
// detectLanAddresses() logic verbatim (same exclusion pattern, same
// os.networkInterfaces() iteration) — mirrored rather than imported, since
// this is a separate repo/build; matches this codebase's existing precedent
// of independently mirroring AgentHealthSnapshot in server/ws/index.ts.
//
// Called fresh on every health push (see sync/live.ts), not cached once at
// boot, so a genuine mid-session IP change (DHCP renewal, switching
// Ethernet<->WiFi) is actually observable downstream — os.networkInterfaces()
// is cheap enough to call on every ~2s health tick.
const VIRTUAL_ADAPTER_PATTERN = /vEthernet|VMware|VirtualBox|Loopback|Tailscale|ZeroTier|Hyper-V|WSL|Docker/i

export interface AgentNetworkAddress {
  name: string
  address: string
}

export interface AgentNetworkInfo {
  addresses: AgentNetworkAddress[]
  preferred: AgentNetworkAddress | null
}

export function detectAgentNetworkInfo(): AgentNetworkInfo {
  const interfaces = os.networkInterfaces()
  const addresses: AgentNetworkAddress[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push({ name, address: entry.address })
      }
    }
  }
  return { addresses, preferred: addresses[0] ?? null }
}
