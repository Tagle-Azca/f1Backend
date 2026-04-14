import { F1_HEADERS } from '../utils/http.js'

const BASE    = 'https://api.jolpi.ca/ergast/f1'
const TIMEOUT = 15_000

async function fetchJSON(url) {
  const res = await fetch(url, { headers: F1_HEADERS, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`Jolpica HTTP ${res.status} — ${url}`)
  return res.json()
}

export async function fetchRaceResultsByYear(year) {
  const json = await fetchJSON(`${BASE}/${year}/results.json?limit=500`)
  return json?.MRData?.RaceTable?.Races || []
}

export async function fetchRoundResults(year, round) {
  const json = await fetchJSON(`${BASE}/${year}/${round}/results.json`)
  return json?.MRData?.RaceTable?.Races?.[0] || null
}

export async function fetchSprintResultsByYear(year) {
  const json = await fetchJSON(`${BASE}/${year}/sprint.json?limit=200`)
  return json?.MRData?.RaceTable?.Races || []
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
