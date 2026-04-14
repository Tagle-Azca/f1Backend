import logger from '../utils/logger.js'

const OPENF1  = 'https://api.openf1.org/v1'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     '*/*',
  'Referer':    'https://www.formula1.com/',
}
const TIMEOUT  = 25_000
const LIVE_TTL =  5_000  

// ── Caches ────────────────────────────────────────────────────────────────────

const sessionCache = new Map()  
const inFlight     = new Map()  
const ttlCache     = new Map() 

// ── Internal helpers ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function of1Fetch(path, retries = 3, backoff = 1200) {
  const resp = await fetch(`${OPENF1}${path}`, {
    headers: HEADERS,
    signal:  AbortSignal.timeout(TIMEOUT),
  })
  if (resp.status === 429 && retries > 0) {
    await sleep(backoff)
    return of1Fetch(path, retries - 1, backoff * 2)
  }
  if (!resp.ok) throw new Error(`OpenF1 ${resp.status} ${path}`)
  return resp.json()
}

async function cachedFetch(sessionKey, resource, path) {
  const k = `${sessionKey}:${resource}`
  if (sessionCache.has(k)) return sessionCache.get(k)
  if (inFlight.has(k)) return inFlight.get(k)

  const promise = of1Fetch(path)
    .then(data => { sessionCache.set(k, data); inFlight.delete(k); return data })
    .catch(err  => { inFlight.delete(k); throw err })

  inFlight.set(k, promise)
  return promise
}

async function ttlFetch(key, path, ttlMs = LIVE_TTL) {
  const hit = ttlCache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.data
  const data = await of1Fetch(path)
  ttlCache.set(key, { data, expiresAt: Date.now() + ttlMs })
  return data
}

// ── Race session catalogue ────────────────────────────────────────────────────

let _raceSessionsCache = null
let _raceSessionsAt    = 0
const RACE_SESSIONS_TTL = 60 * 60_000

// ── Exports ───────────────────────────────────────────────────────────────────

// Driver 1 location probe — used by the service layer to detect an active session
export async function fetchLatestLocation(sinceMs) {
  const since = new Date(Date.now() - sinceMs).toISOString()
  return of1Fetch(`/location?session_key=latest&date_gt=${since}&driver_number=1`)
}

export async function fetchDrivers(sessionKey) {
  return cachedFetch(sessionKey, 'drivers', `/drivers?session_key=${sessionKey}`)
}

// TTL variant used by the live timing tower (needs fresher data than session cache)
export async function fetchDriversLive(sessionKey) {
  return ttlFetch(`drivers:${sessionKey}`, `/drivers?session_key=${sessionKey}`)
}

// Without driverNumber: full session, permanently cached.
// With driverNumber: single driver, no cache (per-driver calls are not shared).
export async function fetchLaps(sessionKey, driverNumber = null) {
  if (driverNumber != null)
    return of1Fetch(`/laps?session_key=${sessionKey}&driver_number=${driverNumber}`)
  return cachedFetch(sessionKey, 'laps', `/laps?session_key=${sessionKey}`)
}

export async function fetchLapsLive(sessionKey) {
  return ttlFetch(`laps:${sessionKey}`, `/laps?session_key=${sessionKey}`)
}

export async function fetchRecentLaps(sessionKey, since) {
  return of1Fetch(`/laps?session_key=${sessionKey}&date>=${since}`)
}

// Same cache split as fetchLaps — full session cached, single driver not.
export async function fetchPits(sessionKey, driverNumber = null) {
  if (driverNumber != null)
    return of1Fetch(`/pit?session_key=${sessionKey}&driver_number=${driverNumber}`)
  return cachedFetch(sessionKey, 'pit', `/pit?session_key=${sessionKey}`)
}

export async function fetchStints(sessionKey) {
  return cachedFetch(sessionKey, 'stints', `/stints?session_key=${sessionKey}`)
}

export async function fetchStintsLive(sessionKey) {
  return ttlFetch(`stints:${sessionKey}`, `/stints?session_key=${sessionKey}`)
}

export async function fetchPositions(sessionKey) {
  return cachedFetch(sessionKey, 'position', `/position?session_key=${sessionKey}`)
}

export async function fetchRecentPositions(sessionKey, since) {
  return of1Fetch(`/position?session_key=${sessionKey}&date>=${since}`)
}

export async function fetchRecentIntervals(sessionKey, since) {
  return of1Fetch(`/intervals?session_key=${sessionKey}&date>=${since}`)
}

export async function fetchRaceControl(sessionKey) {
  return cachedFetch(sessionKey, 'race_control', `/race_control?session_key=${sessionKey}`)
}

export async function fetchLiveLocation(sinceMs) {
  const since = new Date(Date.now() - sinceMs).toISOString()
  return of1Fetch(`/location?session_key=latest&date_gt=${since}`)
}

export async function fetchLiveCarData(sinceMs) {
  const since = new Date(Date.now() - sinceMs).toISOString()
  return of1Fetch(`/car_data?session_key=latest&date_gt=${since}`)
}

// All Race sessions from 2023 to current year. Cached 1 hour.
export async function getOpenF1RaceSessions() {
  const now = Date.now()
  if (_raceSessionsCache && now - _raceSessionsAt < RACE_SESSIONS_TTL)
    return _raceSessionsCache

  const thisYear = new Date().getFullYear()
  const years    = Array.from({ length: thisYear - 2023 + 1 }, (_, i) => 2023 + i)
  const all      = []

  await Promise.allSettled(
    years.map(async y => {
      try {
        const sessions = await of1Fetch(`/sessions?session_type=Race&year=${y}`)
        if (Array.isArray(sessions)) all.push(...sessions)
      } catch (err) {
        logger.warn({ year: y, err: err.message }, '[openf1Repo] failed to fetch sessions for year')
      }
    })
  )

  _raceSessionsCache = all
  _raceSessionsAt    = now
  return all
}
