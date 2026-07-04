import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchRaceResultsByYear,
  fetchRoundResults,
  fetchSprintResultsByYear,
  fetchQualifyingByRound,
  fetchCalendar,
  fetchRaceSchedule,
  fetchSprintResultsByRound,
} from './jolpicaRepository.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(data, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  }))
}

const jolpicaRace = (overrides = {}) => ({
  season: '2024', round: '1', raceName: 'Bahrain Grand Prix',
  date: '2024-03-02', Results: [{ position: '1' }],
  ...overrides,
})

afterEach(() => vi.unstubAllGlobals())

// ── fetchRaceResultsByYear ────────────────────────────────────────────────────

function mockPagedFetch(pages) {
  const mock = vi.fn()
  for (const page of pages) {
    mock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(page) })
  }
  vi.stubGlobal('fetch', mock)
}

describe('fetchRaceResultsByYear', () => {
  it('returns Races array', async () => {
    const races = [jolpicaRace(), jolpicaRace({ round: '2' })]
    mockFetch({ MRData: { total: '2', RaceTable: { Races: races } } })

    const result = await fetchRaceResultsByYear('2024')
    expect(result).toEqual(races)
  })

  it('returns empty array when MRData is missing', async () => {
    mockFetch({})
    const result = await fetchRaceResultsByYear('2024')
    expect(result).toEqual([])
  })

  it('throws on non-ok response', async () => {
    mockFetch({}, false)
    await expect(fetchRaceResultsByYear('2024')).rejects.toThrow('Jolpica HTTP 500')
  })

  it('calls the correct URL', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    await fetchRaceResultsByYear('2024')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toContain('/2024/results.json')
    expect(url).toContain('limit=100')
    expect(url).toContain('offset=0')
  })

  it('fetches all pages and merges a race split across page boundaries', async () => {
    const page1 = { MRData: { total: '120', RaceTable: { Races: [
      jolpicaRace({ round: '1', Results: [{ position: '1' }, { position: '2' }] }),
      jolpicaRace({ round: '2', Results: [{ position: '1' }] }),
    ] } } }
    const page2 = { MRData: { total: '120', RaceTable: { Races: [
      jolpicaRace({ round: '2', Results: [{ position: '2' }, { position: '3' }] }),
      jolpicaRace({ round: '3', Results: [{ position: '1' }] }),
    ] } } }
    mockPagedFetch([page1, page2])

    const result = await fetchRaceResultsByYear('2024')

    expect(vi.mocked(fetch).mock.calls).toHaveLength(2)
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('offset=100')
    expect(result).toHaveLength(3)
    expect(result.find(r => r.round === '2').Results).toEqual(
      [{ position: '1' }, { position: '2' }, { position: '3' }]
    )
  })
})

// ── fetchRoundResults ─────────────────────────────────────────────────────────

describe('fetchRoundResults', () => {
  it('returns the first race object', async () => {
    const race = jolpicaRace()
    mockFetch({ MRData: { RaceTable: { Races: [race] } } })

    const result = await fetchRoundResults('2024', '1')
    expect(result).toEqual(race)
  })

  it('returns null when Races is empty', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    const result = await fetchRoundResults('2024', '1')
    expect(result).toBeNull()
  })

  it('calls the correct URL', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    await fetchRoundResults('2024', '3')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toContain('/2024/3/results.json')
  })
})

// ── fetchSprintResultsByYear ──────────────────────────────────────────────────

describe('fetchSprintResultsByYear', () => {
  it('returns sprint races array', async () => {
    const races = [{ season: '2024', round: '5', SprintResults: [] }]
    mockFetch({ MRData: { RaceTable: { Races: races } } })

    const result = await fetchSprintResultsByYear('2024')
    expect(result).toEqual(races)
  })

  it('calls the sprint endpoint', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    await fetchSprintResultsByYear('2024')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toContain('/2024/sprint.json')
  })
})

// ── fetchQualifyingByRound ────────────────────────────────────────────────────

describe('fetchQualifyingByRound', () => {
  it('returns QualifyingResults array', async () => {
    const quali = [{ position: '1', Driver: { driverId: 'max_verstappen' } }]
    mockFetch({ MRData: { RaceTable: { Races: [{ QualifyingResults: quali }] } } })

    const result = await fetchQualifyingByRound('2024', '1')
    expect(result).toEqual(quali)
  })

  it('returns empty array when no qualifying data', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    const result = await fetchQualifyingByRound('2024', '1')
    expect(result).toEqual([])
  })
})

// ── fetchCalendar ─────────────────────────────────────────────────────────────

describe('fetchCalendar', () => {
  it('returns full calendar races array', async () => {
    const races = [jolpicaRace(), jolpicaRace({ round: '2' })]
    mockFetch({ MRData: { RaceTable: { Races: races } } })

    const result = await fetchCalendar('2024')
    expect(result).toHaveLength(2)
    expect(result[0].raceName).toBe('Bahrain Grand Prix')
  })

  it('calls the races endpoint with limit', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    await fetchCalendar('2025')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toContain('/2025/races.json')
    expect(url).toContain('limit=100')
  })
})

// ── fetchRaceSchedule ─────────────────────────────────────────────────────────

describe('fetchRaceSchedule', () => {
  it('returns the full race object with session times', async () => {
    const race = { ...jolpicaRace(), Qualifying: { date: '2024-03-01', time: '15:00:00Z' } }
    mockFetch({ MRData: { RaceTable: { Races: [race] } } })

    const result = await fetchRaceSchedule('2024', '1')
    expect(result.Qualifying).toEqual({ date: '2024-03-01', time: '15:00:00Z' })
  })

  it('returns null when race not found', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    const result = await fetchRaceSchedule('2024', '99')
    expect(result).toBeNull()
  })
})

// ── fetchSprintResultsByRound ─────────────────────────────────────────────────

describe('fetchSprintResultsByRound', () => {
  it('returns race object containing SprintResults', async () => {
    const race = { ...jolpicaRace(), SprintResults: [{ position: '1' }] }
    mockFetch({ MRData: { RaceTable: { Races: [race] } } })

    const result = await fetchSprintResultsByRound('2024', '5')
    expect(result.SprintResults).toHaveLength(1)
  })

  it('calls the sprint endpoint for the given round', async () => {
    mockFetch({ MRData: { RaceTable: { Races: [] } } })
    await fetchSprintResultsByRound('2024', '5')
    const [url] = vi.mocked(fetch).mock.calls[0]
    expect(url).toContain('/2024/5/sprint.json')
  })
})
