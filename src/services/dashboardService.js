import * as raceRepository   from '../repositories/raceRepository.js'
import * as driverRepository from '../repositories/driverRepository.js'
import * as jolpica          from '../repositories/jolpicaRepository.js'
import { getLastSessionSnapshot } from './f1LiveTiming.js'
import { fetchLastSession }       from './lastSessionService.js'
import { buildDriverName, roundPoints } from '../utils/formatters.js'
import logger from '../utils/logger.js'

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

async function safeCalendar(year) {
  try { return await jolpica.fetchCalendar(year) }
  catch { return null }
}

async function resolveLastRace(currentYear, seasonRaces, today) {
  let calendarTotal   = seasonRaces.length
  let jolpicaAllRaces = null

  if (seasonRaces.length < 18) {
    jolpicaAllRaces = await safeCalendar(currentYear)
    if (jolpicaAllRaces?.length > calendarTotal) calendarTotal = jolpicaAllRaces.length
  }

  const currentYearCompleted = seasonRaces.filter(r => toDateStr(r.date) <= today && r.Results?.length)
  let completedRaces = currentYearCompleted

  // Sprint-only rounds (sprint done, race pending) don't count as "completed"
  // but their points must still feed the standings. No date filter: stored
  // results imply the session already happened, and the race date is later
  // than the sprint it would wrongly exclude.
  let standingsRaces = seasonRaces.filter(r => r.Results?.length || r.SprintResults?.length)

  if (!completedRaces.length) {
    const prevRaces    = await raceRepository.findBySeasonForCalendar(String(Number(currentYear) - 1))
    completedRaces = prevRaces.filter(r => r.Results?.length)
    if (!standingsRaces.length) standingsRaces = completedRaces
  }

  const calendarForGapCheck    = jolpicaAllRaces ?? await safeCalendar(currentYear)
  const jolpicaLastCompleted   = (calendarForGapCheck || [])
    .filter(r => toDateStr(r.date) <= today)
    .sort((a, b) => parseInt(b.round) - parseInt(a.round))[0]

  const lastMongoRace      = completedRaces[completedRaces.length - 1] || null
  let lastRaceFromJolpica  = null

  if (jolpicaLastCompleted && (!lastMongoRace || parseInt(jolpicaLastCompleted.round) > parseInt(lastMongoRace.round))) {
    try {
      lastRaceFromJolpica = await jolpica.fetchRoundResults(currentYear, jolpicaLastCompleted.round)
    } catch (err) { logger.warn({ err: err.message }, '[Dashboard] Jolpica lastRace fetch failed, falling back to MongoDB') }
  }

  return {
    lastRace: lastRaceFromJolpica || lastMongoRace,
    lastRaceFromJolpica,
    calendarTotal,
    currentYearCompleted,
    completedRaces,
    standingsRaces,
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
    const jr = await jolpica.fetchRaceSchedule(season, round)
    if (!jr) return null
    const s = {}
    if (jr.FirstPractice)  s.fp1              = { date: jr.FirstPractice.date,  time: jr.FirstPractice.time }
    if (jr.SecondPractice) s.fp2              = { date: jr.SecondPractice.date, time: jr.SecondPractice.time }
    if (jr.ThirdPractice)  s.fp3              = { date: jr.ThirdPractice.date,  time: jr.ThirdPractice.time }
    if (jr.SprintShootout) s.sprintQualifying = { date: jr.SprintShootout.date, time: jr.SprintShootout.time }
    if (jr.Sprint)         s.sprint           = { date: jr.Sprint.date,         time: jr.Sprint.time }
    if (jr.Qualifying)     s.qualifying       = { date: jr.Qualifying.date,     time: jr.Qualifying.time }
    s.race = { date: jr.date, time: jr.time }
    return s
  } catch (err) {
    logger.warn({ err: err.message }, '[Dashboard] Jolpica schedule fetch failed')
    return null
  }
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

  const raceTime = (nextRace.time || '00:00:00').replace(/Z$/i, '')
  const raceDate = new Date(`${nextRace.date}T${raceTime}Z`)
  const schedule = await fetchWeekendSchedule(nextRace.season, nextRace.round)
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

// A snapshot belongs to a race if it was saved within the same race weekend
const SAME_WEEKEND_MS = 4 * 24 * 60 * 60 * 1000

export function isSameRaceWeekend(snapSavedAt, raceDate) {
  if (!snapSavedAt || !raceDate) return false
  const snapMs = new Date(snapSavedAt).getTime()
  const raceMs = new Date(`${toDateStr(raceDate)}T12:00:00Z`).getTime()
  return Number.isFinite(snapMs) && Number.isFinite(raceMs) && Math.abs(snapMs - raceMs) <= SAME_WEEKEND_MS
}

// Fallback for snapshots without savedAt — SignalR meeting names can differ
// from Ergast race names (e.g. "Spanish GP" vs "Barcelona Grand Prix"), so
// date matching above is always preferred.
function matchesRaceName(mongoRaceName, snapRaceName) {
  if (!mongoRaceName || !snapRaceName) return false
  return mongoRaceName.toLowerCase().includes(snapRaceName.toLowerCase().split(' ').slice(0, 2).join(' '))
}

function isSnapshotAlreadyInMongo(completedRaces, snap, isSprint) {
  return completedRaces.some(r => {
    const sameRace = r.date && snap.savedAt
      ? isSameRaceWeekend(snap.savedAt, r.date)
      : matchesRaceName(r.raceName, snap.raceName)
    return sameRace && (isSprint ? r.SprintResults?.length : r.Results?.length)
  })
}

function findSnapshotDriverEntry(driverPoints, driver) {
  const fullName = (driver.fullName || '').toLowerCase()
  const lastName = (driver.lastName || '').toLowerCase()
  return [...driverPoints.values()].find(v => {
    const name = (v.name || '').toLowerCase()
    if (fullName && name === fullName) return true
    // endsWith handles multi-word last names ("de Vries") that split(' ').pop() breaks
    return lastName && name.endsWith(lastName)
  })
}

function applySnapshotToDriverPoints(driverPoints, snap, completedRaces) {
  const isSprint   = snap.sessionName === 'Sprint'
  const POINTS_TBL = isSprint ? SPRINT_POINTS : RACE_POINTS
  if (isSnapshotAlreadyInMongo(completedRaces, snap, isSprint)) return

  logger.info(`[Dashboard] adding snapshot points for ${snap.sessionName} — ${snap.raceName}`)
  for (const driver of snap.classification) {
    const pts = POINTS_TBL[driver.position] || 0
    if (!pts) continue
    let entry = findSnapshotDriverEntry(driverPoints, driver)
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

function finalizeStandings(driverPoints, ctorPoints, snap, completedRaces) {
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

function buildStandingsMapsFromJolpica(driverList, ctorList) {
  const driverPoints = new Map()
  const ctorPoints   = new Map()

  for (const s of driverList) {
    driverPoints.set(s.Driver.driverId, {
      driverId:      s.Driver.driverId,
      name:          `${s.Driver.givenName} ${s.Driver.familyName}`,
      team:          s.Constructors?.[0]?.name || '',
      constructorId: s.Constructors?.[0]?.constructorId || '',
      points:        parseFloat(s.points),
      wins:          parseInt(s.wins),
    })
  }

  for (const s of ctorList) {
    ctorPoints.set(s.Constructor.constructorId, {
      constructorId: s.Constructor.constructorId,
      name:          s.Constructor.name,
      points:        parseFloat(s.points),
      wins:          parseInt(s.wins),
    })
  }

  return { driverPoints, ctorPoints }
}

function buildStandingsMapsFromMongo(completedRaces) {
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

  return { driverPoints, ctorPoints }
}

export function computeStandings(completedRaces, snap) {
  const { driverPoints, ctorPoints } = buildStandingsMapsFromMongo(completedRaces)
  return finalizeStandings(driverPoints, ctorPoints, snap, completedRaces)
}

// ── Export ─────────────────────────────────────────────────────────────────────

export async function getDashboardData() {
  const currentYear = String(new Date().getFullYear())
  const today       = new Date().toISOString().slice(0, 10)

  const seasonRaces = await raceRepository.findBySeasonForCalendar(currentYear)

  const { lastRace, lastRaceFromJolpica, calendarTotal, currentYearCompleted, completedRaces, standingsRaces, jolpicaAllRaces, calendarForGapCheck } =
    await resolveLastRace(currentYear, seasonRaces, today)

  const lastRaceData = buildLastRaceData(lastRace, lastRaceFromJolpica)
  const nextRaceData = await resolveNextRace(seasonRaces, jolpicaAllRaces, calendarForGapCheck, today, Date.now())

  const snap = getLastSessionSnapshot()

  let standings, constructorStandings
  if (lastRaceFromJolpica) {
    // Jolpica already has the latest round, so its standings include the
    // snapshot's session — adding snapshot points on top would double count
    const snapForStandings = snap && isSameRaceWeekend(snap.savedAt, lastRaceFromJolpica.date)
      ? null
      : snap

    const [jDrivers, jCtors] = await Promise.allSettled([
      jolpica.fetchDriverStandings(currentYear),
      jolpica.fetchConstructorStandings(currentYear),
    ])
    if (jDrivers.status === 'fulfilled' && jDrivers.value.length) {
      const { driverPoints, ctorPoints } = buildStandingsMapsFromJolpica(
        jDrivers.value,
        jCtors.status === 'fulfilled' ? jCtors.value : [],
      )
      ;({ standings, constructorStandings } = finalizeStandings(driverPoints, ctorPoints, snapForStandings, standingsRaces))
    } else {
      ;({ standings, constructorStandings } = computeStandings(standingsRaces, snap))
    }
  } else {
    ;({ standings, constructorStandings } = computeStandings(standingsRaces, snap))
  }

  if (standings[0]) {
    const leaderMeta = await driverRepository.findDriverMeta(standings[0].driverId)
    if (leaderMeta) {
      standings[0].photoUrl        = leaderMeta.photoUrl        || null
      standings[0].permanentNumber = leaderMeta.permanentNumber || leaderMeta.code || null
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
