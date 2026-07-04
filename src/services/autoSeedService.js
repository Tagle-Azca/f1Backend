import logger     from '../utils/logger.js'
import * as seedRepo from '../repositories/seedRepository.js'
import { seedDrivers, seedLapsAndPositions, seedPitStops, seedStints, syncRacesForYear } from './raceSyncService.js'

const OPENF1  = 'https://api.openf1.org/v1'
const HEADERS = { 'User-Agent': 'F1IntelligencePlatform/1.0', Accept: 'application/json' }

let scheduledTimeout = null

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.json()
}

// ── Session resolution ────────────────────────────────────────────────────────

async function fetchAndMatchRaceSession(year, raceDateStr) {
  logger.info(`[AutoSeed] Fetching OpenF1 sessions for ${year}...`)
  const sessions = await fetchJSON(`${OPENF1}/sessions?session_name=Race&year=${year}`)
  if (!Array.isArray(sessions) || !sessions.length) {
    logger.warn('[AutoSeed] No OpenF1 sessions found')
    return null
  }
  const session = sessions.find(s => s.date_start?.slice(0, 10) === raceDateStr)
    || sessions
        .filter(s => s.date_start && new Date(s.date_start) <= new Date())
        .sort((a, b) => new Date(b.date_start) - new Date(a.date_start))[0]
  if (!session) {
    logger.warn(`[AutoSeed] No matching OpenF1 session for ${raceDateStr}`)
    return null
  }
  return session
}

// ── Cassandra seed for one race ───────────────────────────────────────────────

async function seedRaceCassandra(raceDate, raceName) {
  if (!seedRepo.isCassandraConnected()) {
    logger.warn('[AutoSeed] Cassandra not connected — skipping seed')
    return false
  }

  const year    = String(raceDate.getFullYear())
  const session = await fetchAndMatchRaceSession(year, raceDate.toISOString().slice(0, 10))
  if (!session) return false

  const raceId = `${session.year}_${session.session_key}`
  if (await seedRepo.raceExists(raceId)) {
    logger.info(`[AutoSeed] ${raceId} already in Cassandra — skipping`)
    return true
  }

  const sessionName = session.meeting_name || raceName || raceId
  logger.info(`[AutoSeed] Seeding ${raceId} — ${sessionName}...`)
  await seedRepo.insertRaceMeta(raceId, sessionName, session.session_key, session.year)

  const drivers = await seedDrivers(raceId, session.session_key)
  await seedLapsAndPositions(raceId, session.session_key, drivers)
  await seedPitStops(raceId, session.session_key)
  await seedStints(raceId, session.session_key)

  logger.info(`[AutoSeed] ✓ Cassandra seed complete for ${raceId}`)
  return true
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function seedWindowsFor(r) {
  const raceDate = new Date(`${r.date}T${(r.time || '14:00:00').replace(/Z$/i, '')}Z`)
  const morning  = new Date(raceDate)
  morning.setUTCDate(morning.getUTCDate() + 1)
  morning.setUTCHours(10, 0, 0, 0)
  const evening = new Date(morning)
  evening.setUTCHours(20, 0, 0, 0)
  return { raceDate, morning, evening, raceName: r.raceName, round: r.round }
}

function scheduleNextSeed(races) {
  if (scheduledTimeout) clearTimeout(scheduledTimeout)

  const now = new Date()
  const windows = races.flatMap(r => {
    const w = seedWindowsFor(r)
    return [
      { ...w, attempt: 1, seedTime: w.morning },
      { ...w, attempt: 2, seedTime: w.evening },
    ]
  }).filter(w => w.seedTime > now)
    .sort((a, b) => a.seedTime - b.seedTime)

  const next = windows[0]
  if (!next) {
    logger.info('[AutoSeed] No upcoming seed windows — season complete')
    return
  }

  const hoursUntil = Math.round((next.seedTime - now) / 3_600_000)
  logger.info(
    `[AutoSeed] Next seed: ${next.raceName} — attempt ${next.attempt}/2` +
    ` in ${hoursUntil}h (${next.seedTime.toISOString()})`
  )

  const MAX_TIMEOUT = 24 * 60 * 60_000
  if (next.seedTime - now > MAX_TIMEOUT) {
    scheduledTimeout = setTimeout(() => scheduleNextSeed(races), MAX_TIMEOUT)
    return
  }

  scheduledTimeout = setTimeout(async () => {
    try {
      await syncRacesForYear(String(next.raceDate.getFullYear()))
    } catch (err) {
      logger.error(`[AutoSeed] Mongo race sync failed for ${next.raceName}: ${err.message}`)
    }

    let seeded = false
    try {
      seeded = await seedRaceCassandra(next.raceDate, next.raceName)
    } catch (err) {
      logger.error(`[AutoSeed] Attempt ${next.attempt} failed for ${next.raceName}: ${err.message}`)
    }
    if (!seeded && next.attempt === 1)
      logger.info(`[AutoSeed] Attempt 1 incomplete — evening retry scheduled for ${next.raceName}`)

    scheduleNextSeed(races)
  }, next.seedTime - now)
}

export function scheduleAutoSeed(races) {
  if (!races?.length) return
  scheduleNextSeed(races)
}
