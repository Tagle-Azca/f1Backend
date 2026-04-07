import * as raceRepository    from '../repositories/raceRepository.js'
import * as circuitRepository from '../repositories/circuitRepository.js'
import SessionSnapshot        from '../models/SessionSnapshot.js'
import { F1_HEADERS as HEADERS } from '../utils/http.js'

const SESSION_NAME_MAP = {
  fp1:    'Practice 1',
  fp2:    'Practice 2',
  fp3:    'Practice 3',
  quali:  'Qualifying',
  sprint: 'Sprint',
  sq:     'Sprint Shootout',
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Is raceDate within the upcoming race weekend window? (up to 4 days before race day) */
function isCurrentWeekend(dateStr, today) {
  if (!dateStr) return false
  const diff = (new Date(dateStr) - new Date(today)) / 86400000
  return diff >= 0 && diff <= 4
}

async function fetchJolpicaCalendar(year) {
  try {
    const resp = await fetch(
      `https://api.jolpi.ca/ergast/f1/${year}/races.json?limit=100`,
      { headers: HEADERS, signal: AbortSignal.timeout(4000) }
    )
    if (!resp.ok) return null
    const json = await resp.json()
    return json?.MRData?.RaceTable?.Races || null
  } catch { return null }
}

async function fetchJolpicaRace(season, round) {
  try {
    const resp = await fetch(
      `https://api.jolpi.ca/ergast/f1/${season}/${round}.json`,
      { headers: HEADERS, signal: AbortSignal.timeout(4000) }
    )
    if (!resp.ok) return null
    const json = await resp.json()
    return json?.MRData?.RaceTable?.Races?.[0] || null
  } catch { return null }
}

function extractSchedule(jr) {
  if (!jr) return null
  const isSprint = !!(jr.SprintShootout || jr.Sprint)
  const s = { isSprint }
  if (jr.FirstPractice)  s.fp1              = { date: jr.FirstPractice.date,  time: jr.FirstPractice.time }
  if (!isSprint && jr.SecondPractice) s.fp2 = { date: jr.SecondPractice.date, time: jr.SecondPractice.time }
  if (!isSprint && jr.ThirdPractice)  s.fp3 = { date: jr.ThirdPractice.date,  time: jr.ThirdPractice.time }
  if (jr.SprintShootout) s.sprintQualifying = { date: jr.SprintShootout.date, time: jr.SprintShootout.time }
  if (jr.Sprint)         s.sprint           = { date: jr.Sprint.date,         time: jr.Sprint.time }
  if (jr.Qualifying)     s.qualifying       = { date: jr.Qualifying.date,     time: jr.Qualifying.time }
  s.race = { date: jr.date, time: jr.time }
  return Object.keys(s).length > 2 ? s : null
}

// ── Public service functions ──────────────────────────────────────────────────

/**
 * Returns an enriched list of races for a season.
 * For the current year: fills missing rounds from Jolpica and overlays sprint flags.
 * Upcoming races include the last circuit winner from historical data.
 *
 * @param {string} season
 * @returns {object[]}
 */
export async function listRaces(season) {
  const currentYear = String(new Date().getFullYear())
  const today       = new Date().toISOString().slice(0, 10)

  const mongoRaces = await raceRepository.aggregateCalendarList(season)

  let races = mongoRaces

  if (season === currentYear) {
    const jolpica = await fetchJolpicaCalendar(currentYear)
    if (jolpica?.length) {
      const jolpicaMap = new Map(jolpica.map(jr => [jr.round, jr]))
      const mongoSet   = new Set(mongoRaces.map(r => r.round))

      for (const jr of jolpica) {
        if (!mongoSet.has(jr.round)) {
          races.push({
            season: jr.season, round: jr.round, raceName: jr.raceName,
            date: jr.date, time: jr.time || null,
            Circuit: {
              circuitId:   jr.Circuit?.circuitId,
              circuitName: jr.Circuit?.circuitName,
              Location:    jr.Circuit?.Location,
            },
            hasResults:          false,
            hasSprint:           !!(jr.Sprint),
            hasSprintQualifying: !!(jr.SprintShootout),
            winner: null,
          })
        }
      }

      races = races.map(r => {
        if (r.hasSprint || r.hasSprintQualifying) return r
        const jr = jolpicaMap.get(r.round)
        if (!jr) return r
        return {
          ...r,
          hasSprint:           !!(jr.Sprint),
          hasSprintQualifying: !!(jr.SprintShootout),
        }
      })

      races.sort((a, b) => parseInt(a.round) - parseInt(b.round))
    }
  }

  // Enrich upcoming races with last circuit winner from MongoDB history
  const upcomingIds = races
    .filter(r => !r.hasResults && r.Circuit?.circuitId)
    .map(r => r.Circuit.circuitId)

  const lastWinnerMap = new Map()
  if (upcomingIds.length) {
    const lastWinners = await raceRepository.findLastWinnersForCircuits(upcomingIds)
    for (const lw of lastWinners) lastWinnerMap.set(lw._id, lw)
  }

  return races.map(r => {
    const base = {
      ...r,
      isCurrentWeekend: !r.hasResults && isCurrentWeekend(r.date, today),
      isUpcoming: !r.hasResults && (!r.date || r.date > today),
    }
    if (!r.hasResults && r.Circuit?.circuitId) {
      const lw = lastWinnerMap.get(r.Circuit.circuitId)
      if (lw) base.lastCircuitWinner = { driver: lw.winner?.Driver, season: lw.season }
    }
    return base
  })
}

/**
 * Returns full race details for a season + round.
 * Falls back to Jolpica if not in MongoDB yet.
 * Enriches with circuit track coords, weekend schedule, and qualifying/race snapshots.
 *
 * @param {string} season
 * @param {string} round
 * @returns {object|null}
 */
export async function getRace(season, round) {
  let race = await raceRepository.findBySeasonRound(season, round)

  if (!race) {
    const jr = await fetchJolpicaRace(season, round)
    if (!jr) return null

    race = {
      season: jr.season, round: jr.round, raceName: jr.raceName,
      date: jr.date, time: jr.time || null, url: jr.url || null,
      Circuit: {
        circuitId:   jr.Circuit?.circuitId,
        circuitName: jr.Circuit?.circuitName,
        Location:    jr.Circuit?.Location,
      },
      Results: [], SprintResults: [], QualifyingResults: [], SprintQualifyingResults: [],
      schedule: extractSchedule(jr),
      fromJolpica: true,
    }

    const circuit = await circuitRepository.findById(race.Circuit.circuitId)
    if (circuit?.trackCoords?.length) race.Circuit.trackCoords = circuit.trackCoords

    return race
  }

  // Enrich with circuit track coords
  const circuit = await circuitRepository.findById(race.Circuit?.circuitId)
  if (circuit?.trackCoords?.length) race.Circuit.trackCoords = circuit.trackCoords

  // Fetch weekend schedule from Jolpica
  const jolpicaRace = await fetchJolpicaRace(season, round)
  race.schedule     = extractSchedule(jolpicaRace)

  // Fill missing qualifying results
  if (!race.QualifyingResults?.length) {
    const snap = await SessionSnapshot.findOne({
      raceName:    race.raceName,
      sessionName: 'Qualifying',
    }).select('sessionName classification savedAt').lean()

    if (snap?.classification?.length) {
      race.qualifyingSnapshot = snap
    } else {
      try {
        const qResp = await fetch(
          `https://api.jolpi.ca/ergast/f1/${season}/${round}/qualifying.json`,
          { headers: HEADERS, signal: AbortSignal.timeout(4000) }
        )
        if (qResp.ok) {
          const qJson    = await qResp.json()
          const qResults = qJson?.MRData?.RaceTable?.Races?.[0]?.QualifyingResults || []
          if (qResults.length) race.QualifyingResults = qResults
        }
      } catch { /* best-effort */ }
    }
  }

  if (!race.SprintQualifyingResults?.length) {
    const snap = await SessionSnapshot.findOne({
      raceName:    race.raceName,
      sessionName: 'Sprint Shootout',
    }).select('sessionName classification savedAt').lean()
    if (snap?.classification?.length) race.sprintQualifyingSnapshot = snap
  }

  // Race results fallback: F1Live snapshot → Jolpica
  if (!race.Results?.length) {
    const snap = await SessionSnapshot.findOne({
      raceName:    race.raceName,
      sessionName: 'Race',
    }).select('sessionName classification totalLaps savedAt').lean()

    if (snap?.classification?.length) {
      race.raceSnapshot = snap
    } else {
      try {
        const rResp = await fetch(
          `https://api.jolpi.ca/ergast/f1/${season}/${round}/results.json`,
          { headers: HEADERS, signal: AbortSignal.timeout(4000) }
        )
        if (rResp.ok) {
          const rJson    = await rResp.json()
          const rResults = rJson?.MRData?.RaceTable?.Races?.[0]?.Results || []
          if (rResults.length) race.Results = rResults
        }
      } catch { /* best-effort */ }
    }
  }

  return race
}

/**
 * Returns the F1Live session snapshot for a given session key.
 * Looks up the race name from MongoDB (or Jolpica if not yet imported).
 *
 * @param {string} season
 * @param {string} round
 * @param {string} session  — one of fp1, fp2, fp3, quali, sprint, sq
 * @returns {object|null}
 */
export async function getSessionSnapshot(season, round, session) {
  const sessionName = SESSION_NAME_MAP[session]
  if (!sessionName) throw new Error(`Invalid session key: ${session}`)

  const race = await raceRepository.findBySeasonRound(season, round)
  let raceName = race?.raceName

  if (!raceName) {
    const jr = await fetchJolpicaRace(season, round)
    raceName  = jr?.raceName
  }
  if (!raceName) return null

  const snapshot = await SessionSnapshot.findOne({ raceName, sessionName })
    .select('-__v -createdAt -updatedAt').lean()
  return snapshot || null
}
