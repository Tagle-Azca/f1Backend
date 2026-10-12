import { describe, it, expect } from 'vitest'
import { resolveHistoricalWinnerId, sessionLabel, findCalendarRace } from './telemetryService.js'

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

// ── findCalendarRace / sessionLabel ───────────────────────────────────────────

describe('findCalendarRace + sessionLabel', () => {
  const calendar = [
    { round: '16', raceName: 'Bahrain Grand Prix in Malaysia', date: '2026-10-04', Circuit: { circuitId: 'sepang' } },
    { round: '17', raceName: 'Singapore Grand Prix', date: '2026-10-11', Circuit: { circuitId: 'marina_bay' } },
  ]
  const session = (o) => ({ session_name: 'Race', country_name: 'Bahrain', circuit_short_name: 'Kuala Lumpur', ...o })
  const label = (s) => sessionLabel(s, findCalendarRace(s, calendar))

  it('matches a race to the GP on the same day', () => {
    const s = session({ date_start: '2026-10-04T07:00:00+00:00' })
    expect(findCalendarRace(s, calendar).round).toBe('16')
    expect(label(s)).toBe('Bahrain Grand Prix in Malaysia')
  })

  it('matches a sprint to the GP that follows it', () => {
    const s = session({ session_name: 'Sprint', date_start: '2026-10-10T09:00:00+00:00' })
    expect(findCalendarRace(s, calendar).round).toBe('17')
    expect(label(s)).toBe('Singapore Grand Prix (Sprint)')
  })

  it('falls back to the OpenF1 country when the calendar has no match', () => {
    const s = session({ date_start: '2026-06-07T13:00:00+00:00' })
    expect(findCalendarRace(s, calendar)).toBeNull()
    expect(label(s)).toBe('Bahrain Grand Prix')
  })

  it('returns null when nothing usable is known', () => {
    expect(label({ session_name: 'Race', date_start: 'bad' })).toBeNull()
  })
})
