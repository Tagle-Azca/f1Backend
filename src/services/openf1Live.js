import logger from '../utils/logger.js'
import { fmtLapTime } from '../utils/formatters.js'
import * as repo from '../repositories/openf1Repository.js'

// ── Session detection state ───────────────────────────────────────────────────

let _liveSessionCache    = null  // { result, expiresAt }
let _liveSessionInFlight = null

// Injected by server.js at startup to break the circular import:
// f1LiveTiming.js already imports from openf1Live.js, so openf1Live.js
// cannot import from f1LiveTiming.js directly.
let _getF1LiveState = null
export function setF1LiveStateGetter(fn) { _getF1LiveState = fn }

// ── Helpers ───────────────────────────────────────────────────────────────────

export function sessionKeyFromRaceId(raceId) {
  const key = parseInt(raceId?.split('_')[1])
  return isNaN(key) ? null : key
}

export function clearLiveSessionCache() {
  _liveSessionCache = null
}

// ── Session detection ─────────────────────────────────────────────────────────

export async function findLiveRaceSession() {
  try {
    const data = await repo.fetchLatestLocation(30 * 60_000)
    if (!Array.isArray(data) || !data.length) return null

    const sessionKey = data[0].session_key
    const year       = new Date().getFullYear()
    const raceName   = _getF1LiveState?.()?.raceName || `Race ${sessionKey}`

    return { raceId: `${year}_${sessionKey}`, raceName, sessionKey, year: String(year), isLive: true }
  } catch {
    return null
  }
}

// Active sessions cached 30s; no-session result held 5 min to avoid hammering OpenF1.
export async function findLiveSession() {
  const now = Date.now()

  if (_liveSessionCache && now < _liveSessionCache.expiresAt)
    return _liveSessionCache.result

  if (_liveSessionInFlight) return _liveSessionInFlight

  _liveSessionInFlight = (async () => {
    try {
      const data = await repo.fetchLatestLocation(3 * 60_000)

      if (!Array.isArray(data) || !data.length) {
        _liveSessionCache = { result: null, expiresAt: now + 5 * 60_000 }
        return null
      }

      const sessionKey  = data[0].session_key
      const f1live      = _getF1LiveState?.()
      const sessionName = f1live?.sessionName || 'Race'
      const raceName    = f1live?.raceName    || ''
      const isRaceType  = f1live?.isRaceType  ?? (sessionName === 'Race' || sessionName === 'Sprint')

      const result = { sessionKey, sessionName, raceName, isRaceType }
      logger.info({ sessionKey, sessionName }, '[Live] active session detected')
      _liveSessionCache = { result, expiresAt: now + 30_000 }
      return result
    } catch (err) {
      const isNoData = err.message?.includes('404')
      const backoff  = isNoData ? 5 * 60_000 : 60_000
      if (!isNoData) logger.error({ err: err.message }, '[Live] findLiveSession error')
      _liveSessionCache = { result: null, expiresAt: now + backoff }
      return null
    } finally {
      _liveSessionInFlight = null
    }
  })()

  return _liveSessionInFlight
}

// ── Live top-3 ────────────────────────────────────────────────────────────────

// Race/Sprint: 2-minute rolling window avoids fetching the entire session history
async function getLiveTop3ForRace(sessionKey, driverMap) {
  const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString()

  const [posResult, intResult, lapResult] = await Promise.allSettled([
    repo.fetchRecentPositions(sessionKey, twoMinAgo),
    repo.fetchRecentIntervals(sessionKey, twoMinAgo),
    repo.fetchRecentLaps(sessionKey, twoMinAgo),
  ])

  const posData = posResult.status === 'fulfilled' ? posResult.value : []
  const intData = intResult.status === 'fulfilled' ? intResult.value : []
  const lapData = lapResult.status === 'fulfilled' ? lapResult.value : []

  if (!posData.length) return null

  const latestPos = new Map()
  for (const p of posData) {
    const e = latestPos.get(p.driver_number)
    if (!e || p.date > e.date) latestPos.set(p.driver_number, p)
  }
  const latestInt = new Map()
  for (const i of intData) {
    const e = latestInt.get(i.driver_number)
    if (!e || i.date > e.date) latestInt.set(i.driver_number, i)
  }

  const currentLap = lapData.length ? Math.max(...lapData.map(l => l.lap_number || 0)) : null

  const top3 = [...latestPos.values()]
    .sort((a, b) => a.position - b.position)
    .slice(0, 3)
    .map(p => {
      const d = driverMap.get(p.driver_number) || {}
      const i = latestInt.get(p.driver_number) || {}
      return {
        position:  p.position,
        driverNum: p.driver_number,
        acronym:   d.name_acronym || String(p.driver_number),
        teamName:  d.team_name    || '',
        teamColor: d.team_colour  ? `#${d.team_colour}` : null,
        stat:      p.position === 1 ? 'LEADER' : (i.gap_to_leader || null),
        statLabel: 'gap',
      }
    })

  return { top3, currentLap }
}

// FP/Qualifying: fastest lap per driver across the full session
async function getLiveTop3ForQualifying(sessionKey, driverMap) {
  const lapData = await repo.fetchLaps(sessionKey)
  if (!Array.isArray(lapData) || !lapData.length) return null

  // Ignore nulls and out-laps (> 200 s)
  const bestPerDriver = new Map()
  for (const l of lapData) {
    if (!l.lap_duration || l.lap_duration > 200) continue
    const existing = bestPerDriver.get(l.driver_number)
    if (!existing || l.lap_duration < existing.lap_duration)
      bestPerDriver.set(l.driver_number, l)
  }

  if (!bestPerDriver.size) return null

  const sorted      = [...bestPerDriver.values()].sort((a, b) => a.lap_duration - b.lap_duration)
  const fastestTime = sorted[0].lap_duration

  const top3 = sorted.slice(0, 3).map((l, i) => {
    const d   = driverMap.get(l.driver_number) || {}
    const gap = i === 0 ? null : +(l.lap_duration - fastestTime).toFixed(3)
    return {
      position:  i + 1,
      driverNum: l.driver_number,
      acronym:   d.name_acronym || String(l.driver_number),
      teamName:  d.team_name    || '',
      teamColor: d.team_colour  ? `#${d.team_colour}` : null,
      stat:      fmtLapTime(l.lap_duration),
      statLabel: gap !== null ? `+${gap.toFixed(3)}` : 'fastest',
    }
  })

  return { top3, currentLap: null }
}

export async function getLiveTop3(sessionKey, isRaceType) {
  const drvData   = await repo.fetchDrivers(sessionKey)
  const driverMap = new Map(drvData.map(d => [d.driver_number, d]))
  return isRaceType
    ? getLiveTop3ForRace(sessionKey, driverMap)
    : getLiveTop3ForQualifying(sessionKey, driverMap)
}

// ── Timing tower ──────────────────────────────────────────────────────────────

function sectorColor(driverBest, sessionBest) {
  if (!driverBest || driverBest === Infinity) return null
  return Math.abs(driverBest - sessionBest) < 0.001 ? 'purple' : 'green'
}

export async function getLiveTimingTower(sessionKey, isRaceType) {
  const [laps, stints, drivers] = await Promise.all([
    repo.fetchLapsLive(sessionKey),
    repo.fetchStintsLive(sessionKey),
    repo.fetchDriversLive(sessionKey),
  ])

  const driverMap = new Map(drivers.map(d => [d.driver_number, d]))

  // Accumulate personal bests and session bests in a single pass
  const bestPerDriver = new Map()
  let sessionBestS1 = Infinity, sessionBestS2 = Infinity, sessionBestS3 = Infinity

  for (const l of laps) {
    if (!l.lap_duration || l.lap_duration > 200) continue
    const num = l.driver_number
    const cur = bestPerDriver.get(num)
      || { lap: Infinity, s1: Infinity, s2: Infinity, s3: Infinity, lapCount: 0 }

    if (l.lap_duration      < cur.lap) cur.lap = l.lap_duration
    if (l.duration_sector_1 < cur.s1)  cur.s1  = l.duration_sector_1
    if (l.duration_sector_2 < cur.s2)  cur.s2  = l.duration_sector_2
    if (l.duration_sector_3 < cur.s3)  cur.s3  = l.duration_sector_3
    cur.lapCount++
    bestPerDriver.set(num, cur)

    if (l.duration_sector_1 && l.duration_sector_1 < sessionBestS1) sessionBestS1 = l.duration_sector_1
    if (l.duration_sector_2 && l.duration_sector_2 < sessionBestS2) sessionBestS2 = l.duration_sector_2
    if (l.duration_sector_3 && l.duration_sector_3 < sessionBestS3) sessionBestS3 = l.duration_sector_3
  }

  if (!bestPerDriver.size) return null

  // Latest stint per driver → current compound
  const compoundMap = new Map()
  for (const s of stints) {
    const cur = compoundMap.get(s.driver_number)
    if (!cur || s.stint_number > cur.stint_number) compoundMap.set(s.driver_number, s)
  }

  const sorted     = [...bestPerDriver.entries()].sort((a, b) => a[1].lap - b[1].lap)
  const leaderTime = sorted[0]?.[1]?.lap

  return sorted.map(([num, best], i) => {
    const d     = driverMap.get(num) || {}
    const stint = compoundMap.get(num)
    const gap   = i === 0 ? null : +(best.lap - leaderTime).toFixed(3)
    return {
      position:   i + 1,
      driverNum:  num,
      acronym:    d.name_acronym || String(num),
      teamName:   d.team_name    || '',
      teamColor:  d.team_colour  ? `#${d.team_colour}` : null,
      compound:   stint ? (stint.compound || 'UNKNOWN').toUpperCase() : null,
      laps:       best.lapCount,
      bestLap:    best.lap,
      bestLapStr: fmtLapTime(best.lap),
      gap,
      gapStr:     gap === null ? 'LEADER' : `+${gap.toFixed(3)}`,
      s1: best.s1 < Infinity ? { time: +best.s1.toFixed(3), color: sectorColor(best.s1, sessionBestS1) } : null,
      s2: best.s2 < Infinity ? { time: +best.s2.toFixed(3), color: sectorColor(best.s2, sessionBestS2) } : null,
      s3: best.s3 < Infinity ? { time: +best.s3.toFixed(3), color: sectorColor(best.s3, sessionBestS3) } : null,
    }
  })
}

// ── Live car data ─────────────────────────────────────────────────────────────

export async function getLiveCarData() {
  const SINCE_MS = 5_000
  const [locResult, carResult] = await Promise.allSettled([
    repo.fetchLiveLocation(SINCE_MS),
    repo.fetchLiveCarData(SINCE_MS),
  ])

  const positions = {}
  if (locResult.status === 'fulfilled' && Array.isArray(locResult.value)) {
    // Entries are chronological; last write per driver = most recent position
    for (const e of locResult.value) {
      if (e.x != null && e.y != null)
        positions[String(e.driver_number)] = { x: e.x, y: e.y }
    }
  }

  const telemetry = {}
  if (carResult.status === 'fulfilled' && Array.isArray(carResult.value)) {
    const latest = new Map()
    for (const e of carResult.value) {
      const num = String(e.driver_number)
      const cur = latest.get(num)
      if (!cur || e.date > cur.date) latest.set(num, e)
    }
    for (const [num, e] of latest) {
      telemetry[num] = {
        rpm: e.rpm ?? null, gear: e.n_gear ?? null, throttle: e.throttle ?? null,
        brake: e.brake ?? null, drs: e.drs ?? null, speed: e.speed ?? null,
      }
    }
  }

  return { positions, telemetry }
}
