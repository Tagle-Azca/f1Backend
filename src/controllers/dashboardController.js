import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
import { getLastSessionSnapshot, getF1LiveClassification, saveSessionSnapshot } from '../services/f1LiveTiming.js'
import { fetchLastSession } from '../services/lastSessionService.js'
import { buildDriverName, roundPoints } from '../utils/formatters.js'
import { F1_HEADERS } from '../utils/http.js'

// Standard F1 points tables
const RACE_POINTS   = { 1:25, 2:18, 3:15, 4:12, 5:10, 6:8, 7:6, 8:4, 9:2, 10:1 }
const SPRINT_POINTS = { 1:8, 2:7, 3:6, 4:5, 5:4, 6:3, 7:2, 8:1 }

// 3-second server-side cache so concurrent users don't all hit OpenF1
let liveCache = null

export async function getDashboard(req, res, next) {
  try {
    const currentYear = String(new Date().getFullYear())
    const today       = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"

    const seasonRaces = await Race.find({ season: currentYear })
      .select('season round raceName date time Circuit Results SprintResults')
      .sort({ round: 1 })
      .lean()

    // ── Full calendar (Jolpica) — for accurate totalRounds ───
    let calendarTotal = seasonRaces.length
    let jolpicaAllRaces = null
    if (seasonRaces.length < 18) {
      try {
        const resp = await fetch(
          `https://api.jolpi.ca/ergast/f1/${currentYear}/races.json?limit=100`,
          { headers: F1_HEADERS, signal: AbortSignal.timeout(4000) }
        )
        if (resp.ok) {
          const json = await resp.json()
          jolpicaAllRaces = json?.MRData?.RaceTable?.Races || []
          if (jolpicaAllRaces.length > calendarTotal) calendarTotal = jolpicaAllRaces.length
        }
      } catch (_) { /* non-critical */ }
    }

    // ── Last completed race ───────────────────────────────
    const currentYearCompleted = seasonRaces.filter(r => r.date && r.date <= today && r.Results?.length)
    let completedRaces = currentYearCompleted

    // Fallback for lastRaceData only: if no current year races done, show last race from prev year
    if (!completedRaces.length) {
      const prevYear = String(Number(currentYear) - 1)
      const prevRaces = await Race.find({ season: prevYear })
        .select('season round raceName date time Circuit Results')
        .sort({ round: 1 })
        .lean()
      completedRaces = prevRaces.filter(r => r.Results?.length)
    }

    const lastRace = completedRaces[completedRaces.length - 1] || null

    let lastRaceData = null
    if (lastRace) {
      const podium = (lastRace.Results || [])
        .filter(r => ['1','2','3'].includes(r.position))
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(r => ({
          position:    Number(r.position),
          driverId:    r.Driver?.driverId   || '',
          name:        buildDriverName(r.Driver),
          constructor: r.Constructor?.name   || '',
          constructorId: r.Constructor?.constructorId || '',
          points:      r.points,
          time:        r.Time?.time         || r.status || '',
        }))

      const winner = podium.find(p => p.position === 1)
      const fastestLap = (lastRace.Results || []).find(r => r.FastestLap?.rank != null && String(r.FastestLap.rank) === '1')

      lastRaceData = {
        season:    lastRace.season,
        round:     lastRace.round,
        raceName:  lastRace.raceName,
        date:      lastRace.date,
        circuit:   lastRace.Circuit?.circuitName || '',
        circuitId: lastRace.Circuit?.circuitId   || '',
        locality:  lastRace.Circuit?.Location?.locality || '',
        country:   lastRace.Circuit?.Location?.country  || '',
        podium,
        winner:    winner || null,
        fastestLap: fastestLap ? {
          name: buildDriverName(fastestLap.Driver),
          time: fastestLap.FastestLap?.Time?.time || '',
          lap:  fastestLap.FastestLap?.lap        || '',
        } : null,
      }
    }

    // ── Next race ─────────────────────────────────────────
    let upcomingRaces = seasonRaces.filter(r =>
      r.date && r.date >= today && !(r.Results?.length)
    )

    if (!upcomingRaces.length) {
      const cal = jolpicaAllRaces || null
      if (cal?.length) {
        upcomingRaces = cal
          .filter(r => r.date && r.date >= today)
          .map(r => ({
            season: r.season, round: r.round, raceName: r.raceName,
            date: r.date, time: r.time || null,
            Circuit: {
              circuitId: r.Circuit?.circuitId, circuitName: r.Circuit?.circuitName,
              Location: r.Circuit?.Location,
            },
            Results: [],
          }))
      }
    }

    const nextRace = upcomingRaces[0] || null

    let nextRaceData = null
    if (nextRace) {
      const raceTime  = (nextRace.time || '00:00:00').replace(/Z$/i, '')
      const raceDate  = new Date(`${nextRace.date}T${raceTime}Z`)
      const daysUntil = Math.ceil((raceDate - new Date()) / (1000 * 60 * 60 * 24))

      // Fetch weekend schedule from Jolpica
      let schedule = null
      try {
        const jolpica = `https://api.jolpi.ca/ergast/f1/${nextRace.season}/${nextRace.round}.json`
        const resp    = await fetch(jolpica, { headers: F1_HEADERS, signal: AbortSignal.timeout(4000) })
        if (resp.ok) {
          const json  = await resp.json()
          const race  = json?.MRData?.RaceTable?.Races?.[0]
          if (race) {
            schedule = {}
            if (race.FirstPractice)  schedule.fp1   = { date: race.FirstPractice.date,  time: race.FirstPractice.time }
            if (race.SecondPractice) schedule.fp2   = { date: race.SecondPractice.date, time: race.SecondPractice.time }
            if (race.ThirdPractice)  schedule.fp3   = { date: race.ThirdPractice.date,  time: race.ThirdPractice.time }
            if (race.SprintShootout) schedule.sprintQualifying = { date: race.SprintShootout.date, time: race.SprintShootout.time }
            if (race.Sprint)         schedule.sprint = { date: race.Sprint.date, time: race.Sprint.time }
            if (race.Qualifying)     schedule.qualifying = { date: race.Qualifying.date, time: race.Qualifying.time }
            schedule.race = { date: race.date, time: race.time }
          }
        }
      } catch (_) { /* schedule stays null */ }

      const SESSION_ORDER  = ['fp1', 'sprintQualifying', 'fp2', 'sprint', 'qualifying', 'fp3', 'race']
      const SESSION_LABELS = {
        fp1: 'FP1', fp2: 'FP2', fp3: 'FP3',
        sprintQualifying: 'Sprint Quali', sprint: 'Sprint',
        qualifying: 'Qualifying', race: 'Race',
      }
      const SESSION_DURATION = {
        fp1: 60, fp2: 60, fp3: 60,
        sprintQualifying: 45, sprint: 30,
        qualifying: 60, race: 120,
      }

      let nextSession    = { key: 'race', label: 'Race', dateTime: raceDate.toISOString() }
      let currentSession = null

      if (schedule) {
        const now = new Date()
        for (const key of SESSION_ORDER) {
          if (!schedule[key]) continue
          const { date: sd, time: st } = schedule[key]
          const dt    = new Date(`${sd}T${(st || '00:00:00').replace(/Z$/i, '')}Z`)
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
            const { date: sd, time: st } = schedule[key]
            const dt = new Date(`${sd}T${(st || '00:00:00').replace(/Z$/i, '')}Z`)
            nextSession = { key, label: SESSION_LABELS[key], dateTime: dt.toISOString() }
            break
          }
        }
      }

      nextRaceData = {
        season:    nextRace.season,
        round:     nextRace.round,
        raceName:  nextRace.raceName,
        date:      nextRace.date,
        time:      nextRace.time || null,
        raceDateTime: raceDate.toISOString(),
        circuit:   nextRace.Circuit?.circuitName || '',
        circuitId: nextRace.Circuit?.circuitId   || '',
        locality:  nextRace.Circuit?.Location?.locality || '',
        country:   nextRace.Circuit?.Location?.country  || '',
        daysUntil: Math.max(0, daysUntil),
        schedule,
        nextSession,
        currentSession,
      }
    }

    // ── Championship standings (top 5) ────────────────────
    const driverPoints = new Map() // driverId → { name, team, constructorId, points }

    for (const race of completedRaces) {
      for (const r of [...(race.Results || []), ...(race.SprintResults || [])]) {
        if (!r.Driver?.driverId) continue
        const id  = r.Driver.driverId
        const pts = parseFloat(r.points) || 0
        if (!driverPoints.has(id)) {
          driverPoints.set(id, {
            driverId:      id,
            name:          buildDriverName(r.Driver),
            team:          r.Constructor?.name           || '',
            constructorId: r.Constructor?.constructorId || '',
            points:        0,
            wins:          0,
          })
        }
        driverPoints.get(id).points += pts
        if (parseInt(r.position) === 1) driverPoints.get(id).wins++
        if (r.Constructor?.name) {
          driverPoints.get(id).team          = r.Constructor.name
          driverPoints.get(id).constructorId = r.Constructor.constructorId
        }
      }
    }

    // Supplement with live-timing snapshot points (sprint/race not yet in MongoDB)
    const snap = getLastSessionSnapshot()
    if (snap?.classification?.length && snap.isRaceType) {
      const isSprint   = snap.sessionName === 'Sprint'
      const POINTS_TBL = isSprint ? SPRINT_POINTS : RACE_POINTS

      const alreadyInMongo = completedRaces.some(r => {
        const nameMatch = r.raceName?.toLowerCase().includes(
          snap.raceName?.toLowerCase().split(' ').slice(0, 2).join(' ')
        )
        return nameMatch && (isSprint ? r.SprintResults?.length : r.Results?.length)
      })

      if (!alreadyInMongo) {
        console.log(`[Dashboard] adding snapshot points for ${snap.sessionName} — ${snap.raceName}`)
        for (const driver of snap.classification) {
          const pts = POINTS_TBL[driver.position] || 0
          if (pts === 0) continue
          let entry = null
          for (const [, v] of driverPoints) {
            if (v.name?.split(' ').pop()?.toLowerCase() === driver.lastName?.toLowerCase()) {
              entry = v; break
            }
          }
          if (!entry) {
            const dId = `snap_${driver.driverNum}`
            driverPoints.set(dId, {
              driverId: dId, name: driver.fullName || driver.acronym,
              team: driver.teamName || '', constructorId: '', points: 0,
            })
            entry = driverPoints.get(dId)
          }
          entry.points += pts
        }
      }
    }

    const standings = [...driverPoints.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, 5)
      .map((d, i) => ({ ...d, position: i + 1, points: roundPoints(d.points) }))

    if (standings[0]) {
      const leaderDoc = await Driver.findOne({ driverId: standings[0].driverId })
        .select('photoUrl permanentNumber code').lean()
      if (leaderDoc) {
        standings[0].photoUrl        = leaderDoc.photoUrl        || null
        standings[0].permanentNumber = leaderDoc.permanentNumber || leaderDoc.code || null
      }
    }

    // ── Constructor standings (top 5) ─────────────────────
    const ctorPoints = new Map()

    for (const race of completedRaces) {
      for (const r of [...(race.Results || []), ...(race.SprintResults || [])]) {
        if (!r.Constructor?.constructorId) continue
        const id  = r.Constructor.constructorId
        const pts = parseFloat(r.points) || 0
        if (!ctorPoints.has(id)) {
          ctorPoints.set(id, { constructorId: id, name: r.Constructor.name, points: 0 })
        }
        ctorPoints.get(id).points += pts
      }
    }

    if (snap?.classification?.length && snap.isRaceType) {
      const isSprint   = snap.sessionName === 'Sprint'
      const POINTS_TBL = isSprint ? SPRINT_POINTS : RACE_POINTS
      const alreadyInMongo = completedRaces.some(r => {
        const nameMatch = r.raceName?.toLowerCase().includes(
          snap.raceName?.toLowerCase().split(' ').slice(0, 2).join(' ')
        )
        return nameMatch && (isSprint ? r.SprintResults?.length : r.Results?.length)
      })
      if (!alreadyInMongo) {
        for (const driver of snap.classification) {
          const pts = POINTS_TBL[driver.position] || 0
          if (pts === 0 || !driver.teamName) continue
          let entry = null
          for (const [, v] of ctorPoints) {
            if (v.name?.toLowerCase() === driver.teamName?.toLowerCase()) { entry = v; break }
          }
          if (!entry) {
            const cId = `snap_${driver.teamName}`
            ctorPoints.set(cId, { constructorId: cId, name: driver.teamName, points: 0 })
            entry = ctorPoints.get(cId)
          }
          entry.points += pts
        }
      }
    }

    const constructorStandings = [...ctorPoints.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, 5)
      .map((c, i) => ({ ...c, position: i + 1, points: roundPoints(c.points) }))

    // ── Most recent session ────────────────────────────────
    const recentSession = await fetchLastSession(nextRaceData, lastRaceData)
    const lastSession   = recentSession
      || (lastRaceData ? { sessionType: 'Race', sessionLabel: 'Race', ...lastRaceData } : null)

    res.json({
      season:               currentYear,
      totalRounds:          calendarTotal,
      roundsDone:           currentYearCompleted.length,
      lastRace:             lastRaceData,
      lastSession,
      nextRace:             nextRaceData,
      standings,
      constructorStandings,
    })
  } catch (err) { next(err) }
}

export async function getLiveDashboard(req, res, next) {
  try {
    if (liveCache && Date.now() - liveCache.ts < 3000) {
      return res.json(liveCache.data)
    }

    const live = getF1LiveClassification()
    if (live?.finished) saveSessionSnapshot()
    if (live) console.log('[Live]', `${live.sessionName} — ${live.raceName}${live.finished ? ' (finished — archiving)' : ''}`)
    if (!live) {
      const data = { isLive: false }
      liveCache = { ts: Date.now(), data }
      return res.json(data)
    }

    const top3 = live.classification.slice(0, 5)

    const data = {
      isLive:         !live.finished,
      finished:       live.finished || false,
      sessionName:    live.sessionName,
      raceName:       live.raceName,
      isRaceType:     live.isRaceType,
      top3,
      classification: live.classification,
      trackStatus:    live.finished ? null : live.trackStatus,
      currentLap:     live.currentLap,
      totalLaps:      live.totalLaps,
      updatedAt:      new Date().toISOString(),
    }
    liveCache = { ts: Date.now(), data }
    res.json(data)
  } catch (err) { next(err) }
}
