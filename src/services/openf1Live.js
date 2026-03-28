/**
 * OpenF1 Live Proxy Service
 *
 * When a raceId is not yet seeded in Cassandra (e.g. a race that happened today),
 * these helpers fetch the same data directly from OpenF1 and return it in the
 * exact same shape the telemetry controller would produce from Cassandra.
 *
 * raceId format is identical to the seeder: "{year}_{session_key}"
 * driverId format is identical to the seeder: String(driver_number)
 */

const OPENF1  = 'https://api.openf1.org/v1'
const HEADERS = { 'User-Agent': 'F1IntelligencePlatform/1.0' }
const TIMEOUT = 10000

// In-memory cache per session_key to avoid redundant OpenF1 round-trips
const cache = new Map()

async function of1Fetch(path) {
  const resp = await fetch(`${OPENF1}${path}`, {
    headers: HEADERS,
    signal:  AbortSignal.timeout(TIMEOUT),
  })
  if (!resp.ok) throw new Error(`OpenF1 ${resp.status} ${path}`)
  return resp.json()
}

function cacheKey(sessionKey, resource) {
  return `${sessionKey}:${resource}`
}

async function cachedFetch(sessionKey, resource, path) {
  const k = cacheKey(sessionKey, resource)
  if (cache.has(k)) return cache.get(k)
  const data = await of1Fetch(path)
  cache.set(k, data)
  return data
}

// ── Helpers ──────────────────────────────────────────────────

/** Extract the OpenF1 session_key from our internal raceId format */
export function sessionKeyFromRaceId(raceId) {
  const key = parseInt(raceId?.split('_')[1])
  return isNaN(key) ? null : key
}

/**
 * Find the most recent/current Race session from OpenF1 for the current year
 * that falls inside a "live window": started within the last 7 days or
 * starts within the next 4 days (covers the full race weekend).
 * Returns { raceId, raceName, sessionKey, year } or null.
 */
export async function findLiveRaceSession() {
  const year = new Date().getFullYear()
  try {
    const sessions = await of1Fetch(`/sessions?session_name=Race&year=${year}`)
    if (!Array.isArray(sessions) || !sessions.length) return null

    const now         = Date.now()
    const PAST_WINDOW = 7 * 24 * 60 * 60 * 1000   // 7 days — covers unseeded race + Monday seeding

    // Sort newest first
    const sorted = [...sessions].sort((a, b) => new Date(b.date_start) - new Date(a.date_start))

    for (const s of sorted) {
      const diff = now - new Date(s.date_start).getTime()  // positive = past (race started)
      // Only proxy races that have already started (diff > 0) and aren't seeded yet (diff < 7 days)
      if (diff >= 0 && diff <= PAST_WINDOW) {
        return {
          raceId:     `${s.year}_${s.session_key}`,
          raceName:   s.meeting_name || s.meeting_official_name || s.location || `Race ${s.session_key}`,
          sessionKey: s.session_key,
          year:       String(s.year),
          isLive:     true,
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// Max duration (ms) per session — generous to handle red flags, delays, pauses
const SESSION_MAX_DURATION = {
  'Practice 1':      120 * 60 * 1000,
  'Practice 2':      120 * 60 * 1000,
  'Practice 3':      120 * 60 * 1000,
  'Sprint Shootout':  90 * 60 * 1000,
  'Sprint':           90 * 60 * 1000,
  'Qualifying':      150 * 60 * 1000,  // Q1+Q2+Q3 with delays can hit 2h+
  'Race':            240 * 60 * 1000,  // 4h for safety cars / suspensions
}

// Cache for findLiveSession: { result, expiresAt }
// Active session → refresh every 30s | No session → don't retry for 5 min
let _liveSessionCache = null

/**
 * Find ANY currently active F1 session (FP, Qualifying, Sprint, Race).
 * A session is "active" if it started and is within its estimated max duration.
 * Returns { sessionKey, sessionName, raceName, isRaceType } or null.
 */
export async function findLiveSession() {
  const now = Date.now()

  // Return cached result if still fresh
  if (_liveSessionCache && now < _liveSessionCache.expiresAt) {
    return _liveSessionCache.result
  }

  const year = new Date().getFullYear()
  try {
    const sessions = await of1Fetch(`/sessions?year=${year}`)
    if (!Array.isArray(sessions) || !sessions.length) {
      _liveSessionCache = { result: null, expiresAt: now + 5 * 60_000 }
      return null
    }

    const sorted = [...sessions].sort((a, b) => new Date(b.date_start) - new Date(a.date_start))

    for (const s of sorted) {
      const start = new Date(s.date_start).getTime()
      if (now < start) continue  // hasn't started yet

      const end = s.date_end
        ? new Date(s.date_end).getTime()
        : start + (SESSION_MAX_DURATION[s.session_name] || 90 * 60 * 1000)

      if (now <= end) {
        const result = {
          sessionKey:  s.session_key,
          sessionName: s.session_name,
          raceName:    s.meeting_name || s.meeting_official_name || s.location || '',
          isRaceType:  s.session_name === 'Race' || s.session_name === 'Sprint',
        }
        console.log(`[Live] findLiveSession: LIVE → ${s.session_name} key=${s.session_key}`)
        _liveSessionCache = { result, expiresAt: now + 30_000 }  // recheck in 30s
        return result
      }
    }

    // No active session — don't hammer OpenF1 for 5 minutes
    console.log('[Live] findLiveSession: no active session, caching for 5min')
    _liveSessionCache = { result: null, expiresAt: now + 5 * 60_000 }
    return null
  } catch (err) {
    console.error('[Live] findLiveSession error:', err.message)
    // On error, cache for 1 minute to avoid hammering a failing endpoint
    _liveSessionCache = { result: null, expiresAt: now + 60_000 }
    return null
  }
}

/** Force-clear the live session cache (e.g. when F1Live connects/disconnects) */
export function clearLiveSessionCache() {
  _liveSessionCache = null
}

// ── Live timing (dashboard) ───────────────────────────────────

/**
 * Fetch top-3 for the dashboard.
 * - Race / Sprint → positions + gaps (from /position + /intervals)
 * - FP / Qualifying / Sprint Shootout → fastest lap times (from /laps, all session)
 * Returns null if no data is available yet.
 */
export async function getLiveTop3(sessionKey, isRaceType) {
  const drvData   = await cachedFetch(sessionKey, 'drivers', `/drivers?session_key=${sessionKey}`)
  const driverMap = new Map(drvData.map(d => [d.driver_number, d]))

  if (isRaceType) {
    // ── Race / Sprint: positions + gaps ────────────────────
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()

    const [posResult, intResult, lapResult] = await Promise.allSettled([
      of1Fetch(`/position?session_key=${sessionKey}&date>=${twoMinAgo}`),
      of1Fetch(`/intervals?session_key=${sessionKey}&date>=${twoMinAgo}`),
      of1Fetch(`/laps?session_key=${sessionKey}&date>=${twoMinAgo}`),
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

  } else {
    // ── FP / Qualifying: fastest lap times ────────────────
    // Fetch ALL laps for the session (no time filter — we want the fastest ever set)
    const lapData = await cachedFetch(sessionKey, 'laps', `/laps?session_key=${sessionKey}`)
    if (!Array.isArray(lapData) || !lapData.length) return null

    // Best lap per driver (smallest lap_duration, ignore nulls and obvious out-laps >200s)
    const bestPerDriver = new Map()
    for (const l of lapData) {
      if (!l.lap_duration || l.lap_duration > 200) continue
      const existing = bestPerDriver.get(l.driver_number)
      if (!existing || l.lap_duration < existing.lap_duration) {
        bestPerDriver.set(l.driver_number, l)
      }
    }

    if (!bestPerDriver.size) return null

    const sorted = [...bestPerDriver.values()].sort((a, b) => a.lap_duration - b.lap_duration)
    const fastestTime = sorted[0]?.lap_duration

    const top3 = sorted.slice(0, 3).map((l, i) => {
      const d   = driverMap.get(l.driver_number) || {}
      const gap = i === 0 ? null : +(l.lap_duration - fastestTime).toFixed(3)
      const m   = Math.floor(l.lap_duration / 60)
      const s   = (l.lap_duration % 60).toFixed(3).padStart(6, '0')
      return {
        position:  i + 1,
        driverNum: l.driver_number,
        acronym:   d.name_acronym || String(l.driver_number),
        teamName:  d.team_name    || '',
        teamColor: d.team_colour  ? `#${d.team_colour}` : null,
        stat:      `${m}:${s}`,
        statLabel: gap !== null ? `+${gap.toFixed(3)}` : 'fastest',
      }
    })

    return { top3, currentLap: null }
  }
}

// ── Short-lived cache for live timing (5 s TTL) ──────────────

const ttlCache = new Map() // key → { data, expiresAt }

async function ttlFetch(key, path, ttlMs = 5000) {
  const hit = ttlCache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.data
  const data = await of1Fetch(path)
  ttlCache.set(key, { data, expiresAt: Date.now() + ttlMs })
  return data
}

function fmtLap(sec) {
  if (!sec) return null
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(3).padStart(6, '0')
  return `${m}:${s}`
}

/**
 * Full timing tower for FP / Qualifying / Race.
 * Returns sector color coding: 'purple' (session best), 'green' (personal best), 'yellow'.
 */
export async function getLiveTimingTower(sessionKey, isRaceType) {
  const [laps, stints, drivers] = await Promise.all([
    ttlFetch(`laps:${sessionKey}`,    `/laps?session_key=${sessionKey}`),
    ttlFetch(`stints:${sessionKey}`,  `/stints?session_key=${sessionKey}`),
    ttlFetch(`drivers:${sessionKey}`, `/drivers?session_key=${sessionKey}`),
  ])

  const driverMap = new Map(drivers.map(d => [d.driver_number, d]))

  // ── Best sectors per driver + session bests ───────────────
  const bestPerDriver = new Map() // num → { lap, s1, s2, s3, lapCount }
  let sessionBestS1 = Infinity, sessionBestS2 = Infinity, sessionBestS3 = Infinity

  for (const l of laps) {
    if (!l.lap_duration || l.lap_duration > 200) continue
    const num = l.driver_number
    const cur = bestPerDriver.get(num) || { lap: Infinity, s1: Infinity, s2: Infinity, s3: Infinity, lapCount: 0 }

    if (l.lap_duration < cur.lap) cur.lap = l.lap_duration
    if (l.duration_sector_1 && l.duration_sector_1 < cur.s1) cur.s1 = l.duration_sector_1
    if (l.duration_sector_2 && l.duration_sector_2 < cur.s2) cur.s2 = l.duration_sector_2
    if (l.duration_sector_3 && l.duration_sector_3 < cur.s3) cur.s3 = l.duration_sector_3
    cur.lapCount++
    bestPerDriver.set(num, cur)

    if (l.duration_sector_1 && l.duration_sector_1 < sessionBestS1) sessionBestS1 = l.duration_sector_1
    if (l.duration_sector_2 && l.duration_sector_2 < sessionBestS2) sessionBestS2 = l.duration_sector_2
    if (l.duration_sector_3 && l.duration_sector_3 < sessionBestS3) sessionBestS3 = l.duration_sector_3
  }

  if (!bestPerDriver.size) return null

  // ── Current compound per driver (latest stint) ────────────
  const compoundMap = new Map()
  for (const s of stints) {
    const cur = compoundMap.get(s.driver_number)
    if (!cur || s.stint_number > cur.stint_number) compoundMap.set(s.driver_number, s)
  }

  // ── Sort by best lap, build result ────────────────────────
  const sorted = [...bestPerDriver.entries()]
    .sort((a, b) => a[1].lap - b[1].lap)

  const leaderTime = sorted[0]?.[1]?.lap

  const sectorColor = (driverBest, sessionBest) => {
    if (!driverBest || driverBest === Infinity) return null
    if (Math.abs(driverBest - sessionBest) < 0.001) return 'purple'
    return 'green'
  }

  const result = sorted.map(([num, best], i) => {
    const d       = driverMap.get(num) || {}
    const stint   = compoundMap.get(num)
    const gap     = i === 0 ? null : +(best.lap - leaderTime).toFixed(3)

    return {
      position:    i + 1,
      driverNum:   num,
      acronym:     d.name_acronym || String(num),
      teamName:    d.team_name    || '',
      teamColor:   d.team_colour  ? `#${d.team_colour}` : null,
      compound:    stint ? (stint.compound || 'UNKNOWN').toUpperCase() : null,
      laps:        best.lapCount,
      bestLap:     best.lap,
      bestLapStr:  fmtLap(best.lap),
      gap,
      gapStr:      gap === null ? 'LEADER' : `+${gap.toFixed(3)}`,
      s1: best.s1 < Infinity ? { time: +best.s1.toFixed(3), color: sectorColor(best.s1, sessionBestS1) } : null,
      s2: best.s2 < Infinity ? { time: +best.s2.toFixed(3), color: sectorColor(best.s2, sessionBestS2) } : null,
      s3: best.s3 < Infinity ? { time: +best.s3.toFixed(3), color: sectorColor(best.s3, sessionBestS3) } : null,
    }
  })

  return result
}

// ── Per-endpoint live fetchers ────────────────────────────────

export async function getLiveDrivers(sessionKey) {
  const drivers = await cachedFetch(sessionKey, 'drivers', `/drivers?session_key=${sessionKey}`)
  return drivers.map(d => ({
    driverId: String(d.driver_number),
    acronym:  d.name_acronym || '',
    fullName: d.full_name    || '',
    teamName: d.team_name    || '',
  }))
}

export async function getLiveLapTimes(sessionKey, driverId) {
  const [laps, allStints] = await Promise.all([
    of1Fetch(`/laps?session_key=${sessionKey}&driver_number=${driverId}`),
    cachedFetch(sessionKey, 'stints', `/stints?session_key=${sessionKey}`),
  ])

  const driverStints = allStints.filter(s => String(s.driver_number) === String(driverId))

  return laps
    .filter(l => l.lap_duration != null)
    .map(l => {
      const stint = driverStints.find(s => l.lap_number >= s.lap_start && l.lap_number <= s.lap_end)
      return {
        lap_number: l.lap_number,
        lap_time:   parseFloat(l.lap_duration),
        sector1:    l.duration_sector_1 != null ? parseFloat(l.duration_sector_1) : null,
        sector2:    l.duration_sector_2 != null ? parseFloat(l.duration_sector_2) : null,
        sector3:    l.duration_sector_3 != null ? parseFloat(l.duration_sector_3) : null,
        compound:   stint ? (stint.compound || 'UNKNOWN').toUpperCase() : null,
      }
    })
}

export async function getLivePitStops(sessionKey, driverId) {
  const pits = await of1Fetch(`/pit?session_key=${sessionKey}&driver_number=${driverId}`)
  return pits
    .filter(p => p.pit_duration && p.pit_duration >= 2)
    .sort((a, b) => a.lap_number - b.lap_number)
    .map((p, i) => ({
      stop_number: i + 1,
      lap:         p.lap_number,
      duration:    parseFloat(p.pit_duration),
      time:        p.date || '',
    }))
}

export async function getLiveRacePace(sessionKey, driverIds) {
  return Promise.all(driverIds.map(async driverId => {
    const [laps, pits] = await Promise.all([
      of1Fetch(`/laps?session_key=${sessionKey}&driver_number=${driverId}`),
      of1Fetch(`/pit?session_key=${sessionKey}&driver_number=${driverId}`),
    ])
    const pitLapSet = new Set(
      pits.filter(p => p.pit_duration && p.pit_duration >= 2).map(p => p.lap_number)
    )
    return {
      driverId,
      laps: laps
        .filter(l => l.lap_duration != null)
        .map(l => ({
          lap:   l.lap_number,
          time:  parseFloat(l.lap_duration),
          isPit: pitLapSet.has(l.lap_number),
        })),
    }
  }))
}

export async function getLiveTireStrategy(sessionKey) {
  const [stints, drivers] = await Promise.all([
    cachedFetch(sessionKey, 'stints',  `/stints?session_key=${sessionKey}`),
    cachedFetch(sessionKey, 'drivers', `/drivers?session_key=${sessionKey}`),
  ])

  const driverMap = new Map(drivers.map(d => [d.driver_number, d]))
  const byDriver  = new Map()

  for (const s of stints) {
    const num = s.driver_number
    if (!byDriver.has(num)) byDriver.set(num, [])
    byDriver.get(num).push({
      stintNumber: s.stint_number,
      compound:    (s.compound || 'UNKNOWN').toUpperCase(),
      lapStart:    s.lap_start,
      lapEnd:      s.lap_end,
      tyreAge:     s.tyre_age_at_start || 0,
    })
  }

  return [...byDriver.entries()]
    .map(([num, driverStints]) => {
      const d = driverMap.get(num)
      return {
        driverId: String(num),
        acronym:  d?.name_acronym || String(num),
        fullName: d?.full_name    || '',
        teamName: d?.team_name    || '',
        stints:   driverStints.sort((a, b) => a.stintNumber - b.stintNumber),
      }
    })
    .sort((a, b) => a.acronym.localeCompare(b.acronym))
}

// ── Safety Car / VSC periods ──────────────────────────────────

/**
 * Fetch race control events and return SC/VSC periods as
 * [{ type: 'SC'|'VSC', lapStart, lapEnd }] sorted by lapStart.
 * Works for any sessionKey — historical or live.
 */
export async function getSafetyCarPeriods(sessionKey) {
  const events = await cachedFetch(sessionKey, 'race_control', `/race_control?session_key=${sessionKey}`)
  if (!Array.isArray(events) || !events.length) return []

  // Sort by timestamp — lap_number can be null on end-of-SC events, so date is more reliable
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.date || 0).getTime()
    const tb = new Date(b.date || 0).getTime()
    if (ta !== tb) return ta - tb
    return (a.lap_number ?? 0) - (b.lap_number ?? 0)
  })

  // Debug: log SC/VSC related events to server console
  const relevant = sorted.filter(e => {
    const t = `${e.category} ${e.flag} ${e.message}`.toUpperCase()
    return t.includes('SAFETY') || t.includes('VSC') || t.includes('VIRTUAL')
  })
  if (relevant.length) {
    console.log(`[SC] session=${sessionKey} events:`,
      relevant.map(e => `lap=${e.lap_number ?? 'null'} cat=${e.category} flag=${e.flag} msg=${e.message}`))
  }

  const periods = []
  let openSC  = null  // { type: 'SC',  lapStart }
  let openVSC = null  // { type: 'VSC', lapStart }
  let lastKnownLap = 1

  for (const e of sorted) {
    // Use lap_number if present; otherwise fall back to last known lap
    const lap = e.lap_number != null ? e.lap_number : lastKnownLap
    if (e.lap_number != null) lastKnownLap = e.lap_number

    const flag = (e.flag     || '').toUpperCase().trim()
    const msg  = (e.message  || '').toUpperCase().trim()
    const cat  = (e.category || '').toLowerCase().trim()
    const text = `${flag} ${msg}`

    // ── VSC ──────────────────────────────────────────
    if (cat === 'vsc' || (text.includes('VIRTUAL') && text.includes('SAFETY'))) {
      if (text.includes('DEPLOY')) {
        if (openVSC) periods.push({ ...openVSC, lapEnd: lap })
        openVSC = { type: 'VSC', lapStart: lap }
      } else if (text.includes('END') || text.includes('IN THIS') || text.includes('CLEAR')) {
        if (openVSC) { periods.push({ ...openVSC, lapEnd: lap + 1 }); openVSC = null }
      }
    }
    // ── SC (not VSC) ─────────────────────────────────
    else if (cat === 'safetycar' || (text.includes('SAFETY CAR') && !text.includes('VIRTUAL'))) {
      if (text.includes('DEPLOY')) {
        if (openSC) periods.push({ ...openSC, lapEnd: lap })
        openSC = { type: 'SC', lapStart: lap }
      } else if (text.includes('IN THIS') || text.includes('WITHDRAWN') || text.includes('CLEAR') || text.includes('END')) {
        if (openSC) { periods.push({ ...openSC, lapEnd: lap + 1 }); openSC = null }
      }
    }
  }

  // Safety net: cap unclosed periods — SC rarely runs more than 8 laps, VSC more than 5
  if (openSC)  periods.push({ ...openSC,  lapEnd: openSC.lapStart  + 8 })
  if (openVSC) periods.push({ ...openVSC, lapEnd: openVSC.lapStart + 5 })

  return periods
    .filter(p => p.lapEnd > p.lapStart)
    .sort((a, b) => a.lapStart - b.lapStart)
}

export async function getLivePositions(sessionKey) {
  const [allPos, allLaps, allPits, drivers] = await Promise.all([
    cachedFetch(sessionKey, 'position', `/position?session_key=${sessionKey}`),
    cachedFetch(sessionKey, 'laps',     `/laps?session_key=${sessionKey}`),
    cachedFetch(sessionKey, 'pit',      `/pit?session_key=${sessionKey}`),
    cachedFetch(sessionKey, 'drivers',  `/drivers?session_key=${sessionKey}`),
  ])

  const driverMap = new Map(drivers.map(d => [d.driver_number, d]))

  // Pit sets per driver
  const pitsByDriver = new Map()
  for (const p of allPits) {
    if (!p.pit_duration || p.pit_duration < 2) continue
    const k = String(p.driver_number)
    if (!pitsByDriver.has(k)) pitsByDriver.set(k, new Set())
    pitsByDriver.get(k).add(p.lap_number)
  }

  // Sort position history per driver
  const posByDriver = new Map()
  for (const p of allPos) {
    const k = p.driver_number
    if (!posByDriver.has(k)) posByDriver.set(k, [])
    posByDriver.get(k).push({ t: new Date(p.date).getTime(), pos: p.position })
  }
  for (const arr of posByDriver.values()) arr.sort((a, b) => a.t - b.t)

  // Build lap-end times from laps: lapNum → date_start + lap_duration (same logic as seeder)
  const lapEndTimes = new Map()
  for (const l of allLaps) {
    if (!l.lap_number || !l.lap_duration || !l.date_start) continue
    const lapEndMs = new Date(l.date_start).getTime() + parseFloat(l.lap_duration) * 1000
    if (!lapEndTimes.has(l.lap_number)) lapEndTimes.set(l.lap_number, lapEndMs)
  }

  const maxLap = lapEndTimes.size ? Math.max(...lapEndTimes.keys()) : 0

  // Build per-driver position maps (lap → position), mirroring the seeder
  const driverLapPos = new Map()
  for (const [num, posHistory] of posByDriver) {
    const lapMap = new Map()
    for (const [lap, lapEndMs] of lapEndTimes) {
      let pos = null
      for (const p of posHistory) {
        if (p.t <= lapEndMs) pos = p.pos
        else break
      }
      if (pos !== null) lapMap.set(lap, pos)
    }
    // Backfill lap 1 if missing
    if (!lapMap.has(1) && lapMap.size > 0) {
      const firstLap = Math.min(...lapMap.keys())
      lapMap.set(1, lapMap.get(firstLap))
    }
    driverLapPos.set(num, lapMap)
  }

  // Build positionsByLap array for the chart
  const activeNums = [...driverLapPos.keys()]
  const positionsByLap = Array.from({ length: maxLap }, (_, i) => {
    const lap = i + 1
    const row = { lap }
    for (const num of activeNums) {
      const pos = driverLapPos.get(num)?.get(lap)
      if (pos != null) row[String(num)] = pos
    }
    return row
  })

  // Build driver result list
  const result = [...posByDriver.keys()].map(num => {
    const dId     = String(num)
    const d       = driverMap.get(num)
    const lapMap  = driverLapPos.get(num)
    const lastLap = lapMap?.size ? Math.max(...lapMap.keys()) : null
    const dns     = !lapMap || lapMap.size === 0
    const dnf     = !dns && lastLap !== null && lastLap < maxLap - 1
    return {
      driverId: dId,
      acronym:  d?.name_acronym || dId,
      teamName: d?.team_name    || '',
      pitLaps:  [...(pitsByDriver.get(dId) || [])],
      dns,
      dnf,
      lastLap,
    }
  })

  return { drivers: result, laps: positionsByLap, totalLaps: maxLap }
}
