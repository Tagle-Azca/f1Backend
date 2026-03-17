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

/**
 * Find ANY currently active F1 session (FP, Qualifying, Sprint, Race).
 * A session is "active" if it started and is within its estimated max duration.
 * Returns { sessionKey, sessionName, raceName, isRaceType } or null.
 */
export async function findLiveSession() {
  const year = new Date().getFullYear()
  try {
    const sessions = await of1Fetch(`/sessions?year=${year}`)
    console.log(`[Live] OpenF1 /sessions?year=${year} →`, Array.isArray(sessions) ? `${sessions.length} sessions` : sessions)

    if (!Array.isArray(sessions) || !sessions.length) return null

    const now    = Date.now()
    const sorted = [...sessions].sort((a, b) => new Date(b.date_start) - new Date(a.date_start))

    // Log the 3 most recent sessions for diagnosis
    sorted.slice(0, 3).forEach(s => {
      const diff = Math.round((now - new Date(s.date_start).getTime()) / 60000)
      console.log(`[Live]   ${s.session_name} (key=${s.session_key}) started ${diff}min ago — max=${Math.round((SESSION_MAX_DURATION[s.session_name] || 90*60000)/60000)}min`)
    })

    for (const s of sorted) {
      const diff   = now - new Date(s.date_start).getTime()
      if (diff < 0) continue
      const maxDur = SESSION_MAX_DURATION[s.session_name] || 90 * 60 * 1000
      if (diff <= maxDur) {
        return {
          sessionKey:  s.session_key,
          sessionName: s.session_name,
          raceName:    s.meeting_name || s.meeting_official_name || s.location || '',
          isRaceType:  s.session_name === 'Race' || s.session_name === 'Sprint',
        }
      }
    }
    return null
  } catch (err) {
    console.error('[Live] findLiveSession error:', err.message)
    return null
  }
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
  const laps = await of1Fetch(`/laps?session_key=${sessionKey}&driver_number=${driverId}`)
  return laps
    .filter(l => l.lap_duration != null)
    .map(l => ({
      lap_number: l.lap_number,
      lap_time:   parseFloat(l.lap_duration),
      sector1:    l.duration_sector_1 != null ? parseFloat(l.duration_sector_1) : null,
      sector2:    l.duration_sector_2 != null ? parseFloat(l.duration_sector_2) : null,
      sector3:    l.duration_sector_3 != null ? parseFloat(l.duration_sector_3) : null,
    }))
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
