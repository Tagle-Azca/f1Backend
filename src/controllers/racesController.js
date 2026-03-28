import Race            from '../models/Race.js'
import Circuit         from '../models/Circuit.js'
import SessionSnapshot from '../models/SessionSnapshot.js'
import { F1_HEADERS as HEADERS } from '../utils/http.js'

const SESSION_NAME_MAP = {
  fp1:    'Practice 1',
  fp2:    'Practice 2',
  fp3:    'Practice 3',
  quali:  'Qualifying',
  sprint: 'Sprint',
  sq:     'Sprint Shootout',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  // FP2/FP3 only exist on regular weekends; sprint weekends have Shootout+Sprint instead
  if (!isSprint && jr.SecondPractice) s.fp2 = { date: jr.SecondPractice.date, time: jr.SecondPractice.time }
  if (!isSprint && jr.ThirdPractice)  s.fp3 = { date: jr.ThirdPractice.date,  time: jr.ThirdPractice.time }
  if (jr.SprintShootout) s.sprintQualifying = { date: jr.SprintShootout.date, time: jr.SprintShootout.time }
  if (jr.Sprint)         s.sprint           = { date: jr.Sprint.date,         time: jr.Sprint.time }
  if (jr.Qualifying)     s.qualifying       = { date: jr.Qualifying.date,     time: jr.Qualifying.time }
  s.race = { date: jr.date, time: jr.time }
  return Object.keys(s).length > 2 ? s : null  // >2 because isSprint + race are always present
}

// ── Controllers ───────────────────────────────────────────────────────────────

export async function listRaces(req, res, next) {
  try {
    const { season }  = req.query
    const currentYear = String(new Date().getFullYear())
    if (season) {
      const y = parseInt(season)
      if (isNaN(y) || y < 1950 || y > Number(currentYear)) {
        return res.status(400).json({ message: 'Invalid season' })
      }
    }
    const filter      = season ? { season } : {}
    const today       = new Date().toISOString().slice(0, 10)

    // Use aggregate: avoid loading full Results arrays but still get metadata
    const mongoRaces = await Race.aggregate([
      { $match: filter },
      { $project: {
        season: 1, round: 1, raceName: 1, date: 1, time: 1, Circuit: 1,
        hasResults:          { $gt: [{ $size: { $ifNull: ['$Results', []] } }, 0] },
        hasSprint:           { $gt: [{ $size: { $ifNull: ['$SprintResults', []] } }, 0] },
        hasSprintQualifying: { $gt: [{ $size: { $ifNull: ['$SprintQualifyingResults', []] } }, 0] },
        // P1 winner for display in list
        // Sprint weekends: Results = main race, SprintResults = sprint race.
        // We want the main race P1; fall back to SprintResults P1 if Results empty.
        winner: {
          $let: {
            vars: {
              raceP1: {
                $arrayElemAt: [
                  { $filter: {
                    input: { $ifNull: ['$Results', []] },
                    as: 'r', cond: { $eq: ['$$r.position', '1'] }
                  }}, 0
                ]
              },
              sprintP1: {
                $arrayElemAt: [
                  { $filter: {
                    input: { $ifNull: ['$SprintResults', []] },
                    as: 'r', cond: { $eq: ['$$r.position', '1'] }
                  }}, 0
                ]
              }
            },
            in: { $ifNull: ['$$raceP1', '$$sprintP1'] }
          }
        }
      }},
      { $addFields: { _roundNum: { $toInt: '$round' } } },
      { $sort: { _roundNum: 1 } },
      { $project: { _roundNum: 0 } },
    ])

    let races = mongoRaces

    // For current year: fetch Jolpica to fill missing races AND overlay sprint flags
    if (season === currentYear) {
      const jolpica = await fetchJolpicaCalendar(currentYear)
      if (jolpica?.length) {
        // Build a map of round → jolpica race for sprint detection
        const jolpicaMap = new Map(jolpica.map(jr => [jr.round, jr]))
        const mongoSet   = new Set(mongoRaces.map(r => r.round))

        // Fill races not yet in MongoDB
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
              hasResults: false,
              hasSprint:           !!(jr.Sprint),
              hasSprintQualifying: !!(jr.SprintShootout),
              winner: null,
            })
          }
        }

        // Overlay sprint flags for upcoming MongoDB races (no results yet = arrays empty)
        races = races.map(r => {
          if (r.hasSprint || r.hasSprintQualifying) return r  // already flagged
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

    // For upcoming races, enrich with last circuit winner from MongoDB history
    const upcomingIds = races
      .filter(r => !r.hasResults && r.Circuit?.circuitId)
      .map(r => r.Circuit.circuitId)

    const lastWinnerMap = new Map()
    if (upcomingIds.length) {
      const lastWinners = await Race.aggregate([
        { $match: { 'Circuit.circuitId': { $in: upcomingIds }, 'Results.0': { $exists: true } } },
        { $sort: { season: -1 } },
        { $group: {
          _id: '$Circuit.circuitId',
          season: { $first: '$season' },
          winner: { $first: {
            $arrayElemAt: [
              { $filter: { input: '$Results', as: 'r', cond: { $eq: ['$$r.position', '1'] } } },
              0
            ]
          }}
        }}
      ])
      for (const lw of lastWinners) lastWinnerMap.set(lw._id, lw)
    }

    res.json(races.map(r => {
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
    }))
  } catch (err) { next(err) }
}

export async function getSessionSnapshot(req, res, next) {
  try {
    const { season, round } = req.params
    const { session }       = req.query
    const sessionName       = SESSION_NAME_MAP[session]
    if (!sessionName) return res.status(400).json({ message: 'Invalid session key' })

    // Look up race name to match snapshot
    const race = await Race.findOne({ season, round }, { raceName: 1 }).lean()
    let raceName = race?.raceName

    // Upcoming race not in DB yet — try Jolpica for the name
    if (!raceName) {
      const jr = await fetchJolpicaRace(season, round)
      raceName  = jr?.raceName
    }
    if (!raceName) return res.json(null)

    const snapshot = await SessionSnapshot.findOne({ raceName, sessionName })
      .select('-__v -createdAt -updatedAt').lean()
    res.json(snapshot || null)
  } catch (err) { next(err) }
}

export async function getRace(req, res, next) {
  try {
    const { season, round } = req.params
    let race = await Race.findOne({ season, round }).lean()

    // Fallback: race not in MongoDB yet (upcoming/current weekend) → use Jolpica
    if (!race) {
      const jr = await fetchJolpicaRace(season, round)
      if (!jr) return res.status(404).json({ message: 'Race not found' })
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
      // Try to enrich with track coords from Circuit collection
      const circuit = await Circuit.findOne({ circuitId: race.Circuit.circuitId })
        .select('trackCoords').lean()
      if (circuit?.trackCoords?.length) race.Circuit.trackCoords = circuit.trackCoords
      return res.json(race)
    }

    // Enrich with circuit track coords
    const circuit = await Circuit.findOne({ circuitId: race.Circuit?.circuitId })
      .select('trackCoords').lean()
    if (circuit?.trackCoords?.length) race.Circuit.trackCoords = circuit.trackCoords

    // Fetch weekend schedule from Jolpica
    const jolpicaRace = await fetchJolpicaRace(season, round)
    race.schedule     = extractSchedule(jolpicaRace)

    res.json(race)
  } catch (err) { next(err) }
}
