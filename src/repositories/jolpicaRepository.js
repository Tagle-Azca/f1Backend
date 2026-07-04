import { F1_HEADERS } from '../utils/http.js'

const BASE    = 'https://api.jolpi.ca/ergast/f1'
const TIMEOUT = 15_000

// Jolpica caps `limit` at 100 rows per request regardless of the value sent
const PAGE_LIMIT    = 100
const PAGE_DELAY_MS = 300

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url) {
  const res = await fetch(url, { headers: F1_HEADERS, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`Jolpica HTTP ${res.status} — ${url}`)
  return res.json()
}

/**
 * Fetches every page of a race-table endpoint. Jolpica paginates by result
 * rows (not races), so a race can be split across page boundaries — merge
 * its result rows back together by round.
 */
async function fetchAllRacePages(path, resultsKey) {
  const racesByRound = new Map()
  let offset = 0
  let total  = 0

  do {
    const json = await fetchJSON(`${BASE}/${path}?limit=${PAGE_LIMIT}&offset=${offset}`)
    total = parseInt(json?.MRData?.total) || 0

    for (const race of json?.MRData?.RaceTable?.Races || []) {
      const existing = racesByRound.get(race.round)
      if (existing) {
        existing[resultsKey] = [...(existing[resultsKey] || []), ...(race[resultsKey] || [])]
      } else {
        racesByRound.set(race.round, race)
      }
    }

    offset += PAGE_LIMIT
    if (offset < total) await sleep(PAGE_DELAY_MS)
  } while (offset < total)

  return [...racesByRound.values()]
}

export function fetchRaceResultsByYear(year) {
  return fetchAllRacePages(`${year}/results.json`, 'Results')
}

export async function fetchRoundResults(year, round) {
  const json = await fetchJSON(`${BASE}/${year}/${round}/results.json`)
  return json?.MRData?.RaceTable?.Races?.[0] || null
}

export function fetchSprintResultsByYear(year) {
  return fetchAllRacePages(`${year}/sprint.json`, 'SprintResults')
}

export async function fetchQualifyingByRound(year, round) {
  const json = await fetchJSON(`${BASE}/${year}/${round}/qualifying.json`)
  return json?.MRData?.RaceTable?.Races?.[0]?.QualifyingResults || []
}

export async function fetchCalendar(year) {
  const json = await fetchJSON(`${BASE}/${year}/races.json?limit=100`)
  return json?.MRData?.RaceTable?.Races || []
}

export async function fetchRaceSchedule(season, round) {
  const json = await fetchJSON(`${BASE}/${season}/${round}.json`)
  return json?.MRData?.RaceTable?.Races?.[0] || null
}

export async function fetchSprintResultsByRound(year, round) {
  const json = await fetchJSON(`${BASE}/${year}/${round}/sprint.json`)
  return json?.MRData?.RaceTable?.Races?.[0] || null
}

export async function fetchSprintQualifyingByRound(year, round) {
  const json = await fetchJSON(`${BASE}/${year}/${round}/sprint_qualifying.json`)
  return json?.MRData?.RaceTable?.Races?.[0] || null
}

export async function fetchDriverStandings(year) {
  const json = await fetchJSON(`${BASE}/${year}/driverStandings.json`)
  return json?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || []
}

export async function fetchConstructorStandings(year) {
  const json = await fetchJSON(`${BASE}/${year}/constructorStandings.json`)
  return json?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || []
}
