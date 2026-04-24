import { describe, it, expect, vi } from 'vitest'
import { computeStandings } from './dashboardService.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const result = (driverId, givenName, familyName, position, points, ctorId, ctorName) => ({
  position: String(position),
  points:   String(points),
  Driver:      { driverId, givenName, familyName },
  Constructor: { constructorId: ctorId, name: ctorName },
})

const race = (raceName, results = [], sprintResults = []) => ({
  raceName,
  Results:       results,
  SprintResults: sprintResults,
})

const snapDriver = (position, lastName, fullName, teamName, driverNum) => ({
  position, lastName, fullName, acronym: lastName.slice(0, 3).toUpperCase(),
  teamName, driverNum: String(driverNum),
})

const snap = (raceName, classification, sessionName = 'Race') => ({
  sessionName, raceName, isRaceType: true, classification,
})

// ── Points accumulation ───────────────────────────────────────────────────────

describe('computeStandings — points from Results', () => {
  it('sums points across multiple races for the same driver', () => {
    const races = [
      race('Bahrain GP', [result('max_verstappen', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull')]),
      race('Saudi GP',   [result('max_verstappen', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull')]),
    ]
    const { standings } = computeStandings(races, null)

    expect(standings[0].driverId).toBe('max_verstappen')
    expect(standings[0].points).toBe(50)
  })

  it('ranks drivers by total points descending', () => {
    const races = [race('Bahrain GP', [
      result('max_verstappen', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull'),
      result('lec',            'Charles', 'Leclerc',   2, 18, 'ferrari',  'Ferrari'),
    ])]
    const { standings } = computeStandings(races, null)

    expect(standings[0].driverId).toBe('max_verstappen')
    expect(standings[1].driverId).toBe('lec')
    expect(standings[0].position).toBe(1)
    expect(standings[1].position).toBe(2)
  })

  it('counts wins correctly', () => {
    const races = [
      race('Bahrain GP', [result('max_verstappen', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull')]),
      race('Saudi GP',   [result('max_verstappen', 'Max', 'Verstappen', 2, 18, 'red_bull', 'Red Bull')]),
    ]
    const { standings } = computeStandings(races, null)

    expect(standings[0].wins).toBe(1)
  })

  it('includes SprintResults points', () => {
    const sprintResult = result('max_verstappen', 'Max', 'Verstappen', 1, 8, 'red_bull', 'Red Bull')
    const raceResult   = result('max_verstappen', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull')
    const races = [race('China GP', [raceResult], [sprintResult])]
    const { standings } = computeStandings(races, null)

    expect(standings[0].points).toBe(33)
  })

  it('returns empty arrays when no races', () => {
    const { standings, constructorStandings } = computeStandings([], null)
    expect(standings).toEqual([])
    expect(constructorStandings).toEqual([])
  })
})

// ── Constructor standings ─────────────────────────────────────────────────────

describe('computeStandings — constructor standings', () => {
  it('sums points from both drivers in the same team', () => {
    const races = [race('Bahrain GP', [
      result('max_verstappen', 'Max',    'Verstappen', 1, 25, 'red_bull', 'Red Bull'),
      result('per',            'Sergio', 'Perez',      2, 18, 'red_bull', 'Red Bull'),
    ])]
    const { constructorStandings } = computeStandings(races, null)

    expect(constructorStandings[0].constructorId).toBe('red_bull')
    expect(constructorStandings[0].points).toBe(43)
  })

  it('ranks constructors by total points', () => {
    const races = [race('Bahrain GP', [
      result('ver', 'Max',     'Verstappen', 1, 25, 'red_bull', 'Red Bull'),
      result('lec', 'Charles', 'Leclerc',   2, 18, 'ferrari',  'Ferrari'),
    ])]
    const { constructorStandings } = computeStandings(races, null)

    expect(constructorStandings[0].constructorId).toBe('red_bull')
    expect(constructorStandings[1].constructorId).toBe('ferrari')
    expect(constructorStandings[0].position).toBe(1)
  })
})

// ── Snapshot — points applied ─────────────────────────────────────────────────

describe('computeStandings — live snapshot', () => {
  it('adds snapshot points when race is not yet in MongoDB', () => {
    const completedRaces = [
      race('Bahrain Grand Prix', [result('ver', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull')]),
    ]
    // Monaco is not in completedRaces → snapshot points should be added
    const liveSnap = snap('Monaco Grand Prix', [
      snapDriver(1, 'Verstappen', 'Max Verstappen', 'Red Bull', 1),
    ])

    const { standings } = computeStandings(completedRaces, liveSnap)
    const ver = standings.find(d => d.driverId === 'ver')

    // 25 from Bahrain + 25 (P1 snapshot) = 50
    expect(ver.points).toBe(50)
  })

  it('does NOT apply snapshot when race is already in MongoDB', () => {
    const completedRaces = [
      race('Bahrain Grand Prix', [result('ver', 'Max', 'Verstappen', 1, 25, 'red_bull', 'Red Bull')]),
    ]
    // Same race name → isSnapshotAlreadyInMongo returns true → snapshot skipped
    const liveSnap = snap('Bahrain Grand Prix', [
      snapDriver(1, 'Verstappen', 'Max Verstappen', 'Red Bull', 1),
    ])

    const { standings } = computeStandings(completedRaces, liveSnap)
    const ver = standings.find(d => d.driverId === 'ver')

    expect(ver.points).toBe(25)  // unchanged
  })

  it('creates a new entry for a driver not yet in completedRaces', () => {
    const completedRaces = []
    const liveSnap = snap('Bahrain Grand Prix', [
      snapDriver(1, 'Verstappen', 'Max Verstappen', 'Red Bull', 1),
    ])

    const { standings } = computeStandings(completedRaces, liveSnap)

    expect(standings).toHaveLength(1)
    expect(standings[0].points).toBe(25)
    expect(standings[0].name).toBe('Max Verstappen')
  })

  it('does not apply snapshot when isRaceType is false', () => {
    const liveSnap = {
      sessionName: 'Qualifying', raceName: 'Bahrain Grand Prix',
      isRaceType: false,
      classification: [snapDriver(1, 'Verstappen', 'Max Verstappen', 'Red Bull', 1)],
    }
    const { standings } = computeStandings([], liveSnap)

    expect(standings).toHaveLength(0)
  })

  it('applies sprint points table for Sprint session type', () => {
    const completedRaces = []
    const sprintSnap = snap('China Grand Prix', [
      snapDriver(1, 'Verstappen', 'Max Verstappen', 'Red Bull', 1),
    ], 'Sprint')

    const { standings } = computeStandings(completedRaces, sprintSnap)

    // Sprint P1 = 8 points (not 25)
    expect(standings[0].points).toBe(8)
  })
})
