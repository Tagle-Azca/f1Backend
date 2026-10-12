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

// Calendar and weekend schedules are read on every dashboard request, but only
// change a few times a season. Keep the last good copy so a Jolpica 429/outage
// serves stale data instead of blanking the next race.
const FRESH_MS = 10 * 60 * 1000
const STALE_MS = 24 * 60 * 60 * 1000
const cache    = new Map()   // key -> { value, at }
const inflight = new Map()   // key -> Promise (dedupes concurrent requests)

async function cachedJSON(url) {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.value
  if (inflight.has(url)) return inflight.get(url)

  const p = fetchJSON(url)
    .then(value => { cache.set(url, { value, at: Date.now() }); return value })
    .catch(err => {
      if (hit && Date.now() - hit.at < STALE_MS) return hit.value
      throw err
    })
    .finally(() => inflight.delete(url))
  inflight.set(url, p)
  return p
}

/** Test hook: drops cached calendar/schedule responses. */
export function clearJolpicaCache() {
  cache.clear()
  inflight.clear()
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
  const json = await cachedJSON(`${BASE}/${year}/races.json?limit=100`)
  return json?.MRData?.RaceTable?.Races || []
}

export async function fetchRaceSchedule(season, round) {
  const json = await cachedJSON(`${BASE}/${season}/${round}.json`)
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

/**
 * Fetches a single circuit's metadata (name, location) by circuitId.
 * Jolpica has this even for brand-new circuits with zero race history yet
 * (e.g. a track debuting this season), unlike our own MongoDB Circuit
 * collection which is only populated from past race results.
 */
export async function fetchCircuitById(circuitId) {
  const json = await fetchJSON(`${BASE}/circuits/${circuitId}.json`)
  return json?.MRData?.CircuitTable?.Circuits?.[0] || null
}
