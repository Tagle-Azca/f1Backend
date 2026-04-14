import * as raceRepository            from '../repositories/raceRepository.js'
import * as circuitRepository         from '../repositories/circuitRepository.js'
import * as sessionSnapshotRepository from '../repositories/sessionSnapshotRepository.js'
import * as jolpica                   from '../repositories/jolpicaRepository.js'

const SESSION_NAME_MAP = {
  fp1:    'Practice 1',
  fp2:    'Practice 2',
  fp3:    'Practice 3',
  quali:  'Qualifying',
  sprint: 'Sprint',
  sq:     'Sprint Shootout',
}

// ── Private helpers ───────────────────────────────────────────────────────────

function isCurrentWeekend(dateStr, today) {
  if (!dateStr) return false
  const diff = (new Date(dateStr) - new Date(today)) / 86400000
  return diff >= 0 && diff <= 4
}

async function safeCalendar(year) {
  try { return await jolpica.fetchCalendar(year) }
  catch { return null }
}

async function safeRaceSchedule(season, round) {
  try { return await jolpica.fetchRaceSchedule(season, round) }
  catch { return null }
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

export async function listRaces(season) {
  const currentYear = String(new Date().getFullYear())
  const today       = new Date().toISOString().slice(0, 10)

  const mongoRaces = await raceRepository.aggregateCalendarList(season)
  let races = mongoRaces

  if (season === currentYear) {
    const jolpicaRaces = await safeCalendar(currentYear)
    if (jolpicaRaces?.length) {
      const jolpicaMap = new Map(jolpicaRaces.map(jr => [jr.round, jr]))
      const mongoSet   = new Set(mongoRaces.map(r => r.round))

      for (const jr of jolpicaRaces) {
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
        return { ...r, hasSprint: !!(jr.Sprint), hasSprintQualifying: !!(jr.SprintShootout) }
      })

      races.sort((a, b) => parseInt(a.round) - parseInt(b.round))
    }
  }

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

export async function getRace(season, round) {
  let race = await raceRepository.findBySeasonRound(season, round)

  if (!race) {
    const jr = await safeRaceSchedule(season, round)
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

  // Fetch weekend schedule
  const jr   = await safeRaceSchedule(season, round)
  race.schedule = extractSchedule(jr)

  // Fill missing qualifying results
  if (!race.QualifyingResults?.length) {
    const snap = await sessionSnapshotRepository.findByRaceAndSession(race.raceName, 'Qualifying')

    if (snap?.classification?.length) {
      race.qualifyingSnapshot = snap
    } else {
      try {
        const qResults = await jolpica.fetchQualifyingByRound(season, round)
        if (qResults.length) race.QualifyingResults = qResults
      } catch { /* best-effort */ }
    }
  }

  if (!race.SprintQualifyingResults?.length) {
    const snap = await sessionSnapshotRepository.findByRaceAndSession(race.raceName, 'Sprint Shootout')
    if (snap?.classification?.length) race.sprintQualifyingSnapshot = snap
  }

  // Race results fallback: F1Live snapshot → Jolpica
  if (!race.Results?.length) {
    const snap = await sessionSnapshotRepository.findByRaceAndSession(race.raceName, 'Race')

    if (snap?.classification?.length) {
      race.raceSnapshot = snap
    } else {
      try {
        const raceData = await jolpica.fetchRoundResults(season, round)
        if (raceData?.Results?.length) race.Results = raceData.Results
      } catch { /* best-effort */ }
    }
  }

  return race
}

export async function getSessionSnapshot(season, round, session) {
  const sessionName = SESSION_NAME_MAP[session]
  if (!sessionName) throw new Error(`Invalid session key: ${session}`)

  const race = await raceRepository.findBySeasonRound(season, round)
  let raceName = race?.raceName

  if (!raceName) {
    const jr = await safeRaceSchedule(season, round)
    raceName  = jr?.raceName
  }
  if (!raceName) return null

  return sessionSnapshotRepository.findByRaceAndSession(raceName, sessionName)
}
