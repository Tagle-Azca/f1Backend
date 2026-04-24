import { describe, it, expect } from 'vitest'
import { computeH2H } from './teammateService.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const driver = (givenName, familyName, position) => ({
  position: String(position),
  Driver: { givenName, familyName },
  Constructor: { constructorId: 'red_bull' },
})

const qualiDriver = (givenName, familyName, position, q3) => ({
  position: String(position),
  Driver: { givenName, familyName },
  Q3: q3,
})

const race = (results = [], qualiResults = []) => ({
  Results: results,
  QualifyingResults: qualiResults,
})

// Shorthands para VER y PER
const ver = pos => driver('Max', 'Verstappen', pos)
const per = pos => driver('Sergio', 'Perez', pos)
const verQ = (pos, q3) => qualiDriver('Max', 'Verstappen', pos, q3)
const perQ = (pos, q3) => qualiDriver('Sergio', 'Perez', pos, q3)

const VER = 'max verstappen'
const PER = 'sergio perez'

// ── Race H2H ──────────────────────────────────────────────────────────────────

describe('computeH2H — race', () => {
  it('counts driver win when driver finishes ahead', () => {
    const races = [race([ver(1), per(2)])]
    const result = computeH2H(races, VER, PER)

    expect(result.racesCompared).toBe(1)
    expect(result.race).toEqual({ driver: 1, teammate: 0 })
  })

  it('counts teammate win when teammate finishes ahead', () => {
    const races = [race([per(1), ver(2)])]
    const result = computeH2H(races, VER, PER)

    expect(result.race).toEqual({ driver: 0, teammate: 1 })
  })

  it('accumulates across multiple races', () => {
    const races = [
      race([ver(1), per(2)]),  // driver wins
      race([per(1), ver(2)]),  // teammate wins
      race([ver(1), per(3)]),  // driver wins
    ]
    const result = computeH2H(races, VER, PER)

    expect(result.racesCompared).toBe(3)
    expect(result.race).toEqual({ driver: 2, teammate: 1 })
  })

  it('skips race when only one driver has a result', () => {
    const races = [race([ver(1)])]
    const result = computeH2H(races, VER, PER)

    expect(result.racesCompared).toBe(0)
    expect(result.race).toBeNull()
  })

  it('returns null for race when no races compared', () => {
    const result = computeH2H([], VER, PER)
    expect(result.race).toBeNull()
    expect(result.racesCompared).toBe(0)
  })
})

// ── Qualifying H2H ────────────────────────────────────────────────────────────

describe('computeH2H — qualifying', () => {
  it('counts driver when driver qualifies ahead', () => {
    const races = [race([], [verQ(1, '1:30.000'), perQ(2, '1:30.500')])]
    const result = computeH2H(races, VER, PER)

    expect(result.qualiCompared).toBe(1)
    expect(result.quali).toEqual({ driver: 1, teammate: 0 })
  })

  it('counts teammate when teammate qualifies ahead', () => {
    const races = [race([], [perQ(1, '1:30.000'), verQ(2, '1:30.500')])]
    const result = computeH2H(races, VER, PER)

    expect(result.quali).toEqual({ driver: 0, teammate: 1 })
  })

  it('accumulates quali H2H across races', () => {
    const races = [
      race([], [verQ(1, '1:30.000'), perQ(2, '1:30.500')]),  // driver P1
      race([], [perQ(1, '1:29.800'), verQ(2, '1:30.100')]),  // teammate P1
      race([], [verQ(1, '1:31.000'), perQ(2, '1:31.200')]),  // driver P1
    ]
    const result = computeH2H(races, VER, PER)

    expect(result.qualiCompared).toBe(3)
    expect(result.quali).toEqual({ driver: 2, teammate: 1 })
  })

  it('returns null for quali when no qualifying data', () => {
    const races = [race([ver(1), per(2)])]  // solo race, sin quali
    const result = computeH2H(races, VER, PER)

    expect(result.quali).toBeNull()
    expect(result.qualiCompared).toBe(0)
  })
})

// ── avgQualiGapSeconds ────────────────────────────────────────────────────────

describe('computeH2H — avgQualiGapSeconds', () => {
  it('returns negative gap when driver is faster', () => {
    // VER: 1:30.000 (90.0s), PER: 1:30.500 (90.5s) → gap = 90.0 - 90.5 = -0.5
    const races = [race([], [verQ(1, '1:30.000'), perQ(2, '1:30.500')])]
    const result = computeH2H(races, VER, PER)

    expect(result.avgQualiGapSeconds).toBe(-0.5)
  })

  it('returns positive gap when teammate is faster', () => {
    // VER: 1:30.500, PER: 1:30.000 → gap = 90.5 - 90.0 = +0.5
    const races = [race([], [perQ(1, '1:30.000'), verQ(2, '1:30.500')])]
    const result = computeH2H(races, VER, PER)

    expect(result.avgQualiGapSeconds).toBe(0.5)
  })

  it('averages gap across multiple qualifying sessions', () => {
    // Race 1: VER -0.5s, Race 2: VER -0.3s → avg = -0.4
    const races = [
      race([], [verQ(1, '1:30.000'), perQ(2, '1:30.500')]),
      race([], [verQ(1, '1:29.700'), perQ(2, '1:30.000')]),
    ]
    const result = computeH2H(races, VER, PER)

    expect(result.avgQualiGapSeconds).toBe(-0.4)
  })

  it('returns null when no timing data is available', () => {
    // Qualifying results exist but no Q times
    const races = [race([], [
      { position: '1', Driver: { givenName: 'Max', familyName: 'Verstappen' } },
      { position: '2', Driver: { givenName: 'Sergio', familyName: 'Perez' } },
    ])]
    const result = computeH2H(races, VER, PER)

    expect(result.avgQualiGapSeconds).toBeNull()
  })

  it('parses Q2 time when Q3 is absent', () => {
    const races = [race([], [
      { position: '1', Driver: { givenName: 'Max', familyName: 'Verstappen' }, Q2: '1:30.000' },
      { position: '2', Driver: { givenName: 'Sergio', familyName: 'Perez' }, Q2: '1:30.500' },
    ])]
    const result = computeH2H(races, VER, PER)

    expect(result.avgQualiGapSeconds).toBe(-0.5)
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('computeH2H — edge cases', () => {
  it('handles empty races array', () => {
    const result = computeH2H([], VER, PER)
    expect(result).toEqual({
      racesCompared: 0, qualiCompared: 0,
      race: null, quali: null, avgQualiGapSeconds: null,
    })
  })

  it('ignores races where driver names do not match', () => {
    const races = [race([
      driver('Charles', 'Leclerc', 1),
      driver('Carlos', 'Sainz', 2),
    ])]
    const result = computeH2H(races, VER, PER)
    expect(result.racesCompared).toBe(0)
  })
})
