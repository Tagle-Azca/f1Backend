import { describe, it, expect } from 'vitest'
import { buildDriverName, roundPoints, normalizeRaceName, fmtLapTime } from './formatters.js'

// ── buildDriverName ───────────────────────────────────────────────────────────

describe('buildDriverName', () => {
  it('joins givenName and familyName', () => {
    expect(buildDriverName({ givenName: 'Max', familyName: 'Verstappen' })).toBe('Max Verstappen')
  })

  it('handles missing familyName', () => {
    expect(buildDriverName({ givenName: 'Max' })).toBe('Max')
  })

  it('handles missing givenName', () => {
    expect(buildDriverName({ familyName: 'Verstappen' })).toBe('Verstappen')
  })

  it('returns empty string for null', () => {
    expect(buildDriverName(null)).toBe('')
  })

  it('returns empty string for empty object', () => {
    expect(buildDriverName({})).toBe('')
  })
})

// ── roundPoints ───────────────────────────────────────────────────────────────

describe('roundPoints', () => {
  it('returns integer unchanged', () => {
    expect(roundPoints(25)).toBe(25)
  })

  it('rounds to one decimal place', () => {
    expect(roundPoints(8.55)).toBe(8.6)
    expect(roundPoints(8.54)).toBe(8.5)
  })

  it('converts string to number', () => {
    expect(roundPoints('18')).toBe(18)
  })

  it('returns 0 for null or undefined', () => {
    expect(roundPoints(null)).toBe(0)
    expect(roundPoints(undefined)).toBe(0)
  })

  it('returns 0 for non-numeric string', () => {
    expect(roundPoints('abc')).toBe(0)
  })
})

// ── normalizeRaceName ─────────────────────────────────────────────────────────

describe('normalizeRaceName', () => {
  it('replaces Grand Prix with GP', () => {
    expect(normalizeRaceName('British Grand Prix')).toBe('British GP')
    expect(normalizeRaceName('Monaco Grand Prix')).toBe('Monaco GP')
  })

  it('leaves names without Grand Prix unchanged', () => {
    expect(normalizeRaceName('Sprint')).toBe('Sprint')
  })

  it('returns empty string for null', () => {
    expect(normalizeRaceName(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(normalizeRaceName(undefined)).toBe('')
  })
})

// ── fmtLapTime ────────────────────────────────────────────────────────────────

describe('fmtLapTime', () => {
  it('formats seconds to M:SS.mmm', () => {
    expect(fmtLapTime(90.123)).toBe('1:30.123')
  })

  it('pads seconds below 10 with leading zero', () => {
    expect(fmtLapTime(61.5)).toBe('1:01.500')
  })

  it('handles sub-minute times', () => {
    expect(fmtLapTime(59.999)).toBe('0:59.999')
  })

  it('returns null for 0', () => {
    expect(fmtLapTime(0)).toBeNull()
  })

  it('returns null for null', () => {
    expect(fmtLapTime(null)).toBeNull()
  })
})
