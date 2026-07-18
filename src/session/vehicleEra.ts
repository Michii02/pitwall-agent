/**
 * Vehicle-era detection — which F1 25 car generation a session used.
 *
 * F1 25 content spans two meaningfully different vehicle generations
 * reachable from the same install: the original 2025-spec cars, and cars
 * following the "2026 Season Pack" regulations. Derived from the Session
 * packet's m_formula field (verified against primary source: same field,
 * same byte position as the pre-2026 spec, just a new valid value — see
 * SessionPacket.formula in ../udp/packets/common.ts).
 *
 * Deliberately conservative: only m_formula is used. A proposed second
 * signal (CarTelemetry2's m_2026Regulations flag) exists in the 2026 spec
 * but that packet's byte layout isn't independently verified yet, so it's
 * not parsed at all (see parser.ts) and can't be used here. Anything that
 * doesn't map to a known value resolves to 'unknown' rather than a guess —
 * a session broadcasting in legacy UDP format while actually running 2026
 * cars is a real, disclosed case this can't distinguish from a genuine
 * 2025 session.
 */

export type VehicleEra = '2025' | '2026' | 'unknown'

// Pre-2026 m_formula values: F1 Modern, F1 Classic, F2, F1 Generic, Beta,
// Esports, F1 World, F1 Elimination.
const KNOWN_2025_FORMULAS = new Set([0, 1, 2, 3, 4, 6, 8, 9])

const FORMULA_2026 = 13

export function deriveVehicleEra(formula: number | null | undefined): VehicleEra {
  if (formula === FORMULA_2026) return '2026'
  if (formula != null && KNOWN_2025_FORMULAS.has(formula)) return '2025'
  return 'unknown'
}
