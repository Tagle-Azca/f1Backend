import { describe, it, expect } from 'vitest'
import { resolveHistoricalWinnerId } from './telemetryService.js'

// ── resolveHistoricalWinnerId ─────────────────────────────────────────────────
// Finds the race winner via 3 fallback strategies:
//   1. Position data → scan backwards from final lap for position=1
//   2. Driver whose last stint ends exactly at totalLaps
//   3. Driver with the globally highest lap_end (most laps completed)

describe('resolveHistoricalWinnerId', () => {

  // ── Strategy 1: position data ───────────────────────────────────────────────

  it('returns driver with position=1 on the final lap', () => {
    const stints  = []
    const posRows = [
      { driver_id: '1', lap: 57, position: 1 },
      { driver_id: '11', lap: 57, position: 2 },
    ]
    expect(resolveHistoricalWinnerId(stints, posRows, 57)).toBe('1')
  })

  it('scans up to 5 laps back when final lap has no position=1', () => {
    const posRows = [
      { driver_id: '1', lap: 55, position: 1 },   // 2 laps before max
      { driver_id: '11', lap: 57, position: 2 },
    ]
    expect(resolveHistoricalWinnerId([], posRows, 57)).toBe('1')
  })

  it('handles position stored as string', () => {
    const posRows = [
      { driver_id: '44', lap: 50, position: '1' },
    ]
    expect(resolveHistoricalWinnerId([], posRows, 50)).toBe('44')
  })

  // ── Strategy 2: last stint ends at totalLaps ────────────────────────────────

  it('falls back to driver whose stint ends at totalLaps when no position data', () => {
    const stints = [
      { driver_id: '1',  stint_number: 3, lap_end: 57 },
      { driver_id: '11', stint_number: 2, lap_end: 55 },
    ]
    expect(resolveHistoricalWinnerId(stints, [], 57)).toBe('1')
  })

  it('picks the highest stint_number when two drivers end at totalLaps', () => {
    const stints = [
      { driver_id: '1',  stint_number: 3, lap_end: 57 },
      { driver_id: '44', stint_number: 2, lap_end: 57 },
    ]
    expect(resolveHistoricalWinnerId(stints, [], 57)).toBe('1')
  })

  // ── Strategy 3: highest lap_end ─────────────────────────────────────────────

  it('falls back to driver with highest lap_end when totalLaps is null', () => {
    const stints = [
      { driver_id: '1',  stint_number: 1, lap_end: 57 },
      { driver_id: '11', stint_number: 1, lap_end: 44 },
    ]
    expect(resolveHistoricalWinnerId(stints, [], null)).toBe('1')
  })

  it('ignores stints with null lap_end in strategy 3', () => {
    const stints = [
      { driver_id: '1',  stint_number: 1, lap_end: null },
      { driver_id: '11', stint_number: 1, lap_end: 57 },
    ]
    expect(resolveHistoricalWinnerId(stints, [], null)).toBe('11')
  })

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('returns null when stints and posRows are both empty', () => {
    expect(resolveHistoricalWinnerId([], [], null)).toBeNull()
  })

  it('returns null when all lap_end values are null', () => {
    const stints = [
      { driver_id: '1', stint_number: 1, lap_end: null },
    ]
    expect(resolveHistoricalWinnerId(stints, [], null)).toBeNull()
  })
})
