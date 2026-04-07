import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
import { getLastSessionSnapshot } from './f1LiveTiming.js'
import { fetchLastSession } from './lastSessionService.js'
import { buildDriverName, roundPoints } from '../utils/formatters.js'
import { F1_HEADERS } from '../utils/http.js'

const RACE_POINTS   = { 1:25, 2:18, 3:15, 4:12, 5:10, 6:8, 7:6, 8:4, 9:2, 10:1 }
const SPRINT_POINTS = { 1:8, 2:7, 3:6, 4:5, 5:4, 6:3, 7:2, 8:1 }

const SESSION_ORDER    = ['fp1', 'sprintQualifying', 'fp2', 'sprint', 'qualifying', 'fp3', 'race']
const SESSION_LABELS   = { fp1: 'FP1', fp2: 'FP2', fp3: 'FP3', sprintQualifying: 'Sprint Quali', sprint: 'Sprint', qualifying: 'Qualifying', race: 'Race' }
const SESSION_DURATION = { fp1: 60, fp2: 60, fp3: 60, sprintQualifying: 45, sprint: 30, qualifying: 60, race: 120 }

const toDateStr = v => {
  if (!v) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

// ── Calendar helpers ───────────────────────────────────────────────────────────

async function fetchJolpicaCalendar(year) {
  try {
    const resp = await fetch(
      `https://api.jolpi.ca/ergast/f1/${year}/races.json?limit=100`,
      { headers: F1_HEADERS, signal: AbortSignal.timeout(4000) }
    )
    if (resp.ok) return (await resp.json())?.MRData?.RaceTable?.Races || []
  } catch (_) { /* non-critical */ }
  return null
}

async function resolveLastRace(currentYear, seasonRaces, today) {
  let calendarTotal   = seasonRaces.length
  let jolpicaAllRaces = null

  if (seasonRaces.length < 18) {
    jolpicaAllRaces = await fetchJolpicaCalendar(currentYear)
    if (jolpicaAllRaces?.length > calendarTotal) calendarTotal = jolpicaAllRaces.length
  }

  const currentYearCompleted = seasonRaces.filter(r => toDateStr(r.date) <= today && r.Results?.length)
  let completedRaces = currentYearCompleted

  if (!completedRaces.length) {
    const prevRaces = await Race.find({ season: String(Number(currentYear) - 1) })
      .select('season round raceName date time Circuit Results')
      .sort({ round: 1 }).lean()
    completedRaces = prevRaces.filter(r => r.Results?.length)
  }

  const calendarForGapCheck = jolpicaAllRaces ?? await fetchJolpicaCalendar(currentYear)
  const jolpicaLastCompleted = (calendarForGapCheck || [])
    .filter(r => toDateStr(r.date) <= today)
    .sort((a, b) => parseInt(b.round) - parseInt(a.round))[0]

  const lastMongoRace = completedRaces[completedRaces.length - 1] || null
  let lastRaceFromJolpica = null

  if (jolpicaLastCompleted && (!lastMongoRace || parseInt(jolpicaLastCompleted.round) > parseInt(lastMongoRace.round))) {
    try {
      const resp = await fetch(
        `https://api.jolpi.ca/ergast/f1/${currentYear}/${jolpicaLastCompleted.round}/results.json`,
        { headers: F1_HEADERS, signal: AbortSignal.timeout(5000) }
      )
      if (resp.ok) lastRaceFromJolpica = (await resp.json())?.MRData?.RaceTable?.Races?.[0] || null
    } catch (_) { /* fall back to MongoDB */ }
  }

  return {
    lastRace: lastRaceFromJolpica || lastMongoRace,
    lastRaceFromJolpica,
    calendarTotal,
    currentYearCompleted,
    completedRaces,
    jolpicaAllRaces,
    calendarForGapCheck,
  }
}

// ── Last race builder ──────────────────────────────────────────────────────────

function buildLastRaceData(lastRace, lastRaceFromJolpica) {
  if (!lastRace) return null

  const results = lastRaceFromJolpica
    ? (lastRaceFromJolpica.Results || []).map(r => ({
        position: r.position, Driver: r.Driver, Constructor: r.Constructor,
        points: r.points, Time: r.Time, status: r.status, FastestLap: r.FastestLap,
      }))
    : (lastRace.Results || [])

  const podium = results
    .filter(r => ['1','2','3'].includes(String(r.position)))
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map(r => ({
      position: Number(r.position), driverId: r.Driver?.driverId || '',
      name: buildDriverName(r.Driver), constructor: r.Constructor?.name || '',
      constructorId: r.Constructor?.constructorId || '',
      points: r.points, time: r.Time?.time || r.status || '',
    }))

  const src      = lastRaceFromJolpica || lastRace
  const circuit  = src.Circuit
  const fastestLap = results.find(r => r.FastestLap?.rank != null && String(r.FastestLap.rank) === '1')

  return {
    season: src.season, round: src.round, raceName: src.raceName, date: src.date,
    circuit: circuit?.circuitName || circuit?.CircuitName || '',
    circuitId: circuit?.circuitId || '',
    locality: circuit?.Location?.locality || '',
    country:  circuit?.Location?.country  || '',
    Results: results.map(r => ({
      position: r.position,
      Driver: { givenName: r.Driver?.givenName, familyName: r.Driver?.familyName, driverId: r.Driver?.driverId },
      status: r.status,
    })),
    podium,
    winner: podium.find(p => p.position === 1) || null,
    fastestLap: fastestLap ? {
      name: buildDriverName(fastestLap.Driver),
      time: fastestLap.FastestLap?.Time?.time || '',
      lap:  fastestLap.FastestLap?.lap        || '',
    } : null,
  }
}

// ── Next race helpers ──────────────────────────────────────────────────────────

async function fetchWeekendSchedule(season, round) {
  try {
    const resp = await fetch(`https://api.jolpi.ca/ergast/f1/${season}/${round}.json`, { headers: F1_HEADERS, signal: AbortSignal.timeout(4000) })
    if (!resp.ok) return null
    const race = (await resp.json())?.MRData?.RaceTable?.Races?.[0]
    if (!race) return null
    const s = {}
    if (race.FirstPractice)  s.fp1              = { date: race.FirstPractice.date,  time: race.FirstPractice.time }
    if (race.SecondPractice) s.fp2              = { date: race.SecondPractice.date, time: race.SecondPractice.time }
    if (race.ThirdPractice)  s.fp3              = { date: race.ThirdPractice.date,  time: race.ThirdPractice.time }
    if (race.SprintShootout) s.sprintQualifying = { date: race.SprintShootout.date, time: race.SprintShootout.time }
    if (race.Sprint)         s.sprint           = { date: race.Sprint.date,         time: race.Sprint.time }
    if (race.Qualifying)     s.qualifying       = { date: race.Qualifying.date,     time: race.Qualifying.time }
    s.race = { date: race.date, time: race.time }
    return s
  } catch (_) { return null }
}

function resolveCurrentAndNextSession(schedule, raceDate) {
  let nextSession = { key: 'race', label: 'Race', dateTime: raceDate.toISOString() }
  let currentSession = null
  if (!schedule) return { nextSession, currentSession }

  const now = new Date()
  for (const key of SESSION_ORDER) {
    if (!schedule[key]) continue
    const dt    = new Date(`${schedule[key].date}T${(schedule[key].time || '00:00:00').replace(/Z$/i, '')}Z`)
    const endDt = new Date(dt.getTime() + (SESSION_DURATION[key] || 60) * 60 * 1000)
    if (dt <= now && now <= endDt) {
      currentSession = { key, label: SESSION_LABELS[key], dateTime: dt.toISOString(), isLive: true }
    } else if (dt > now && !currentSession) {
      nextSession = { key, label: SESSION_LABELS[key], dateTime: dt.toISOString() }
      break
    }
  }

  if (currentSession) {
    const liveIdx = SESSION_ORDER.indexOf(currentSession.key)
    for (let i = liveIdx + 1; i < SESSION_ORDER.length; i++) {
      const key = SESSION_ORDER[i]
      if (!schedule[key]) continue
      const dt = new Date(`${schedule[key].date}T${(schedule[key].time || '00:00:00').replace(/Z$/i, '')}Z`)
      nextSession = { key, label: SESSION_LABELS[key], dateTime: dt.toISOString() }
      break
    }
  }
  return { nextSession, currentSession }
}

async function resolveNextRace(seasonRaces, jolpicaAllRaces, calendarForGapCheck, today, nowMs) {
  const isUpcoming = (dateVal, timeVal) => {
    const dateStr = toDateStr(dateVal)
    if (!dateStr || dateStr < today) return false
    if (dateStr > today) return true
    const startMs = new Date(`${dateStr}T${(timeVal || '00:00:00').replace(/Z$/i, '')}Z`).getTime()
    return (nowMs - startMs) < 4 * 60 * 60 * 1000
  }

  let upcomingRaces = seasonRaces
    .filter(r => isUpcoming(r.date, r.time) && !r.Results?.length)
    .sort((a, b) => toDateStr(a.date).localeCompare(toDateStr(b.date)))

  if (!upcomingRaces.length) {
    const cal = jolpicaAllRaces || calendarForGapCheck
    if (cal?.length) {
      upcomingRaces = cal
        .filter(r => isUpcoming(r.date, r.time))
        .sort((a, b) => toDateStr(a.date).localeCompare(toDateStr(b.date)))
        .map(r => ({
          season: r.season, round: r.round, raceName: r.raceName,
          date: r.date, time: r.time || null, Results: [],
          Circuit: { circuitId: r.Circuit?.circuitId, circuitName: r.Circuit?.circuitName, Location: r.Circuit?.Location },
        }))
    }
  }

  const nextRace = upcomingRaces[0] || null
  if (!nextRace) return null

  const raceTime  = (nextRace.time || '00:00:00').replace(/Z$/i, '')
  const raceDate  = new Date(`${nextRace.date}T${raceTime}Z`)
  const schedule  = await fetchWeekendSchedule(nextRace.season, nextRace.round)
  const { nextSession, currentSession } = resolveCurrentAndNextSession(schedule, raceDate)

  return {
    season: nextRace.season, round: nextRace.round, raceName: nextRace.raceName,
    date: nextRace.date, time: nextRace.time || null, raceDateTime: raceDate.toISOString(),
    circuit: nextRace.Circuit?.circuitName || '', circuitId: nextRace.Circuit?.circuitId || '',
    locality: nextRace.Circuit?.Location?.locality || '', country: nextRace.Circuit?.Location?.country || '',
    daysUntil: Math.max(0, Math.ceil((raceDate - new Date()) / (1000 * 60 * 60 * 24))),
    schedule, nextSession, currentSession,
  }
}

// ── Standings helpers ──────────────────────────────────────────────────────────

function isSnapshotAlreadyInMongo(completedRaces, snap, isSprint) {
  return completedRaces.some(r => {
    const nameMatch = r.raceName?.toLowerCase().includes(snap.raceName?.toLowerCase().split(' ').slice(0, 2).join(' '))
    return nameMatch && (isSprint ? r.SprintResults?.length : r.Results?.length)
  })
}

function applySnapshotToDriverPoints(driverPoints, snap, completedRaces) {
  const isSprint   = snap.sessionName === 'Sprint'
  const POINTS_TBL = isSprint ? SPRINT_POINTS : RACE_POINTS
  if (isSnapshotAlreadyInMongo(completedRaces, snap, isSprint)) return

  console.log(`[Dashboard] adding snapshot points for ${snap.sessionName} — ${snap.raceName}`)
  for (const driver of snap.classification) {
    const pts = POINTS_TBL[driver.position] || 0
    if (!pts) continue
    let entry = [...driverPoints.values()].find(v => v.name?.split(' ').pop()?.toLowerCase() === driver.lastName?.toLowerCase())
    if (!entry) {
      const dId = `snap_${driver.driverNum}`
      driverPoints.set(dId, { driverId: dId, name: driver.fullName || driver.acronym, team: driver.teamName || '', constructorId: '', points: 0 })
      entry = driverPoints.get(dId)
    }
    entry.points += pts
  }
}

function applySnapshotToCtorPoints(ctorPoints, snap, completedRaces) {
  const isSprint   = snap.sessionName === 'Sprint'
  const POINTS_TBL = isSprint ? SPRINT_POINTS : RACE_POINTS
  if (isSnapshotAlreadyInMongo(completedRaces, snap, isSprint)) return

  for (const driver of snap.classification) {
    const pts = POINTS_TBL[driver.position] || 0
    if (!pts || !driver.teamName) continue
    let entry = [...ctorPoints.values()].find(v => v.name?.toLowerCase() === driver.teamName?.toLowerCase())
    if (!entry) {
      const cId = `snap_${driver.teamName}`
      ctorPoints.set(cId, { constructorId: cId, name: driver.teamName, points: 0 })
      entry = ctorPoints.get(cId)
    }
    entry.points += pts
  }
}

function computeStandings(completedRaces, snap) {
  const driverPoints = new Map()
  const ctorPoints   = new Map()

  for (const race of completedRaces) {
    for (const r of [...(race.Results || []), ...(race.SprintResults || [])]) {
      const pts = parseFloat(r.points) || 0

      if (r.Driver?.driverId) {
        const id = r.Driver.driverId
        if (!driverPoints.has(id)) driverPoints.set(id, { driverId: id, name: buildDriverName(r.Driver), team: '', constructorId: '', points: 0, wins: 0 })
        driverPoints.get(id).points += pts
        if (parseInt(r.position) === 1) driverPoints.get(id).wins++
        if (r.Constructor?.name) { driverPoints.get(id).team = r.Constructor.name; driverPoints.get(id).constructorId = r.Constructor.constructorId }
      }

      if (r.Constructor?.constructorId) {
        const id = r.Constructor.constructorId
        if (!ctorPoints.has(id)) ctorPoints.set(id, { constructorId: id, name: r.Constructor.name, points: 0 })
        ctorPoints.get(id).points += pts
      }
    }
  }

  if (snap?.classification?.length && snap.isRaceType) {
    applySnapshotToDriverPoints(driverPoints, snap, completedRaces)
    applySnapshotToCtorPoints(ctorPoints, snap, completedRaces)
  }

  const standings = [...driverPoints.values()]
    .sort((a, b) => b.points - a.points)
    .map((d, i) => ({ ...d, position: i + 1, points: roundPoints(d.points) }))

  const constructorStandings = [...ctorPoints.values()]
    .sort((a, b) => b.points - a.points)
    .map((c, i) => ({ ...c, position: i + 1, points: roundPoints(c.points) }))

  return { standings, constructorStandings }
}

// ── Export ─────────────────────────────────────────────────────────────────────

export async function getDashboardData() {
  const currentYear = String(new Date().getFullYear())
  const today       = new Date().toISOString().slice(0, 10)

  const seasonRaces = await Race.find({ season: currentYear })
    .select('season round raceName date time Circuit Results SprintResults')
    .sort({ round: 1 }).lean()

  const { lastRace, lastRaceFromJolpica, calendarTotal, currentYearCompleted, completedRaces, jolpicaAllRaces, calendarForGapCheck } =
    await resolveLastRace(currentYear, seasonRaces, today)

  const lastRaceData = buildLastRaceData(lastRace, lastRaceFromJolpica)
  const nextRaceData = await resolveNextRace(seasonRaces, jolpicaAllRaces, calendarForGapCheck, today, Date.now())

  const snap = getLastSessionSnapshot()
  const { standings, constructorStandings } = computeStandings(completedRaces, snap)

  if (standings[0]) {
    const leaderDoc = await Driver.findOne({ driverId: standings[0].driverId }).select('photoUrl permanentNumber code').lean()
    if (leaderDoc) {
      standings[0].photoUrl        = leaderDoc.photoUrl        || null
      standings[0].permanentNumber = leaderDoc.permanentNumber || leaderDoc.code || null
    }
  }

  const recentSession = await fetchLastSession(nextRaceData, lastRaceData)
  const lastSession   = recentSession || (lastRaceData ? { sessionType: 'Race', sessionLabel: 'Race', ...lastRaceData } : null)

  return {
    season:               currentYear,
    totalRounds:          calendarTotal,
    roundsDone:           currentYearCompleted.length,
    lastRace:             lastRaceData,
    lastSession,
    nextRace:             nextRaceData,
    standings,
    constructorStandings,
  }
}
