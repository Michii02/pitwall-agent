import type { TelemetryHealth } from '../health/state'
import type { GameVersion } from './packets/common'
import type { ParseResult } from './parser'
import type { ParsedHeader } from './packets/common'
import { isIntentionallyIgnoredPacket, isSupportedPacketFormat, parseHeader, parsePacket } from './parser'

export type PacketDisposition = 'parsed' | 'ignored' | 'malformed' | 'unsupported' | 'parser_error' | 'conflict'

export interface PacketProcessingDependencies {
  health: TelemetryHealth
  versionOverride?: GameVersion
  relay: (buf: Buffer) => void
  onParsed: (result: ParseResult) => void
  acceptParsed?: (result: ParseResult) => boolean
  acceptIgnored?: (header: ParsedHeader) => boolean
  onError?: (error: Error) => void
}

/**
 * The single production boundary between a raw UDP datagram and trusted F1
 * telemetry. Raw bytes are always relayed first. Only a structurally valid,
 * supported packet may advance telemetry health or reach session consumers.
 */
export function processTelemetryDatagram(
  buf: Buffer,
  source: { address: string; port: number },
  dependencies: PacketProcessingDependencies,
): PacketDisposition {
  const { health, versionOverride, relay, onParsed, onError } = dependencies
  const header = parseHeader(buf)
  health.onDatagram(source, header?.packetFormat)
  relay(buf)

  try {
    const result = parsePacket(buf, versionOverride)
    if (result) {
      if (dependencies.acceptParsed && !dependencies.acceptParsed(result)) return 'conflict'
      health.onValidPacket({
        packetFormat: result.header.packetFormat,
        sessionUid: result.header.sessionUid,
        playerVehicleIndex: result.header.playerCarIndex,
      })
      onParsed(result)
      return 'parsed'
    }
    if (!header) {
      health.onMalformedPacket()
      return 'malformed'
    }
    if (!isSupportedPacketFormat(header.packetFormat, versionOverride)) {
      health.onUnsupportedPacket()
      return 'unsupported'
    }
    if (isIntentionallyIgnoredPacket(header.packetId, header.packetFormat, versionOverride)) {
      if (dependencies.acceptIgnored && !dependencies.acceptIgnored(header)) return 'conflict'
      health.onValidPacket({
        packetFormat: header.packetFormat,
        sessionUid: header.sessionUid,
        playerVehicleIndex: header.playerCarIndex,
      })
      return 'ignored'
    }
    health.onMalformedPacket()
    return 'malformed'
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    health.onParserError()
    onError?.(error)
    return 'parser_error'
  }
}
