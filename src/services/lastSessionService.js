import { getLastSessionSnapshot } from './f1LiveTiming.js'
import { buildDriverName } from '../utils/formatters.js'

const JOLPICA_HEADERS = { 'User-Agent': 'F1IntelligencePlatform/1.0' }

// How many minutes each session typically takes (used to decide if it's finished)
const SESSION_DONE_DURATION = {
  fp1: 90, fp2: 90, fp3: 90,
  sprintQualifying: 75, sprint: 60,
  qualifying: 75,  // Q1+Q2+Q3 = ~60min, 15min buffer
}

// Map SignalR session names → schedule keys
const SESSION_NAME_MAP = {
  'Practice 1': 'fp1', 'Practice 2': 'fp2', 'Practice 3': 'fp3',
  'Sprint Qualifying': 'sprintQualifying', 'Sprint Shootout': 'sprintQualifying',
  'Sprint': 'sprint',
  'Qualifying': 'qualifying',
}

/**
 * Returns the most recently completed non-race session from the current race
 * weekend (qualifying, sprint, sprint qualifying, or practice), or null if
 * nothing is newer than lastRaceData.
 */
export async function fetchLastSession(nextRaceData, lastRaceData) {
  if (!nextRaceData?.schedule) return null

  const { season, round, schedule, raceName, circuit, circuitId, locality, country } = nextRaceData
  const now          = new Date()
  const lastRaceDate = lastRaceData?.date ? new Date(lastRaceData.date + 'T23:59:59Z') : new Date(0)

  // ── 1. Try live-timing snapshot first (available immediately after session ends) ──
  const snap = getLastSessionSnapshot()
  if (snap) {
    const snapKey = SESSION_NAME_MAP[snap.sessionName]
    const snapDt  = snap.savedAt ? new Date(snap.savedAt) : null
    const isForThisWeekend = snapDt && snapDt > lastRaceDate
    if (snapKey && isForThisWeekend && schedule[snapKey]) {
      const RACE_TYPES = new Set(['Race', 'Sprint'])
      if (!RACE_TYPES.has(snap.sessionName)) {
        const sessionLabel =
          snap.sessionName === 'Qualifying' ? 'Qualifying' :
          snap.sessionName === 'Sprint'     ? 'Sprint' :
          snap.sessionName.startsWith('Practice') ? snap.sessionName :
          snap.sessionName
        return {
          sessionType:  sessionLabel,
          sessionLabel,
          season, round, raceName, circuit, circuitId, locality, country,
          date: schedule[snapKey].date,
          top3: snap.top3,
          podium: RACE_TYPES.has(snap.sessionName) ? snap.top3?.map(d => ({
            position:      d.position,
            driverId:      d.driverNum,
            name:          d.acronym,
            constructor:   d.teamName,
            constructorId: '',
            time:          d.stat === 'LEADER' ? 'Winner' : d.stat || '',
            points:        '',
          })) : null,
        }
      }
    }
  }

  // Collect all non-race sessions that have already finished
  const completed = []
  for (const [key, val] of Object.entries(schedule)) {
    if (key === 'race') continue
    const dt    = new Date(`${val.date}T${(val.time || '00:00:00').replace(/Z$/i, '')}Z`)
    const endDt = new Date(dt.getTime() + (SESSION_DONE_DURATION[key] || 90) * 60 * 1000)
    if (endDt > now)      continue  // still in the future / in-progress
    if (dt <= lastRaceDate) continue  // older than last race, skip
    completed.push({ key, dt, date: val.date })
  }
  completed.sort((a, b) => b.dt - a.dt)  // most recent first

  for (const { key, date } of completed) {
    try {
      // ── Qualifying ─────────────────────────────────────────
      if (key === 'qualifying') {
        const resp = await fetch(
          `https://api.jolpi.ca/ergast/f1/${season}/${round}/qualifying.json`,
          { headers: JOLPICA_HEADERS, signal: AbortSignal.timeout(4000) }
        )
        if (resp.ok) {
          const json    = await resp.json()
          const results = json?.MRData?.RaceTable?.Races?.[0]?.QualifyingResults || []
          if (results.length) {
            return {
              sessionType: 'Qualifying', sessionLabel: 'Qualifying',
              season, round, raceName, circuit, circuitId, locality, country, date,
              top3: results.slice(0, 5).map(r => ({
                position:      parseInt(r.position),
                driverId:      r.Driver?.driverId || '',
                name:          buildDriverName(r.Driver),
                constructor:   r.Constructor?.name || '',
                constructorId: r.Constructor?.constructorId || '',
                time:          r.Q3 || r.Q2 || r.Q1 || '',
              })),
            }
          }
        }
      }

      // ── Sprint ─────────────────────────────────────────────
      if (key === 'sprint') {
        const resp = await fetch(
          `https://api.jolpi.ca/ergast/f1/${season}/${round}/sprint.json`,
          { headers: JOLPICA_HEADERS, signal: AbortSignal.timeout(4000) }
        )
        if (resp.ok) {
          const json    = await resp.json()
          const results = json?.MRData?.RaceTable?.Races?.[0]?.SprintResults || []
          const podium  = results
            .filter(r => ['1','2','3'].includes(r.position))
            .sort((a, b) => Number(a.position) - Number(b.position))
            .map(r => ({
              position:      Number(r.position),
              driverId:      r.Driver?.driverId || '',
              name:          buildDriverName(r.Driver),
              constructor:   r.Constructor?.name || '',
              constructorId: r.Constructor?.constructorId || '',
              time:          r.Time?.time || r.status || '',
              points:        r.points,
            }))
          if (podium.length) {
            return {
              sessionType: 'Sprint', sessionLabel: 'Sprint',
              season, round, raceName, circuit, circuitId, locality, country, date,
              podium,
            }
          }
        }
      }

      // ── Sprint Qualifying (Shootout) ────────────────────────
      if (key === 'sprintQualifying') {
        const resp = await fetch(
          `https://api.jolpi.ca/ergast/f1/${season}/${round}/sprint_qualifying.json`,
          { headers: JOLPICA_HEADERS, signal: AbortSignal.timeout(4000) }
        )
        if (resp.ok) {
          const json    = await resp.json()
          const race    = json?.MRData?.RaceTable?.Races?.[0]
          const results = race?.SprintQualifyingResults || race?.QualifyingResults || []
          if (results.length) {
            return {
              sessionType: 'Sprint Qualifying', sessionLabel: 'Sprint Quali',
              season, round, raceName, circuit, circuitId, locality, country, date,
              top3: results.slice(0, 5).map(r => ({
                position:      parseInt(r.position),
                driverId:      r.Driver?.driverId || '',
                name:          buildDriverName(r.Driver),
                constructor:   r.Constructor?.name || '',
                constructorId: r.Constructor?.constructorId || '',
                time:          r.SQ3 || r.SQ2 || r.SQ1 || r.Q3 || r.Q2 || r.Q1 || '',
              })),
            }
          }
        }
      }

      // Qualifying / Sprint Qualifying — results pending (Jolpica hasn't updated yet)
      if (key === 'qualifying') {
        return {
          sessionType: 'Qualifying', sessionLabel: 'Qualifying',
          season, round, raceName, circuit, circuitId, locality, country, date,
          top3: null, resultsPending: true,
        }
      }
      if (key === 'sprintQualifying') {
        return {
          sessionType: 'Sprint Qualifying', sessionLabel: 'Sprint Quali',
          season, round, raceName, circuit, circuitId, locality, country, date,
          top3: null, resultsPending: true,
        }
      }
      if (key === 'sprint') {
        return {
          sessionType: 'Sprint', sessionLabel: 'Sprint',
          season, round, raceName, circuit, circuitId, locality, country, date,
          podium: null, resultsPending: true,
        }
      }

      // ── Practice (FP1 / FP2 / FP3) ─────────────────────────
      if (['fp1','fp2','fp3'].includes(key)) {
        const label = key === 'fp1' ? 'Practice 1' : key === 'fp2' ? 'Practice 2' : 'Practice 3'
        return {
          sessionType: key.toUpperCase(), sessionLabel: label,
          season, round, raceName, circuit, circuitId, locality, country, date,
          top3: null,
        }
      }

    } catch { /* try next session */ }
  }

  return null
}
