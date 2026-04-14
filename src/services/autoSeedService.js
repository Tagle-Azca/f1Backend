import logger from '../utils/logger.js'
import * as seedRepo from '../repositories/seedRepository.js'

const OPENF1  = 'https://api.openf1.org/v1'
const HEADERS = { 'User-Agent': 'F1IntelligencePlatform/1.0', Accept: 'application/json' }
const sleep   = ms => new Promise(r => setTimeout(r, ms))

let scheduledTimeout = null

// TODO: move to openf1Repository / jolpicaRepository when those cover these endpoints
async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.json()
}

// ── Cassandra seed for one race ───────────────────────────────────────────────

async function seedRaceCassandra(raceDate, raceName) {
  if (!seedRepo.isCassandraConnected()) {
    logger.warn('[AutoSeed] Cassandra not connected — skipping seed')
    return false
  }

  const year = String(raceDate.getFullYear())

  logger.info(`[AutoSeed] Fetching OpenF1 sessions for ${year}...`)
  const sessions = await fetchJSON(`${OPENF1}/sessions?session_name=Race&year=${year}`)
  if (!Array.isArray(sessions) || !sessions.length) {
    logger.warn('[AutoSeed] No OpenF1 sessions found')
    return false
  }

  const raceDateStr = raceDate.toISOString().slice(0, 10)
  const session = sessions.find(s => s.date_start?.slice(0, 10) === raceDateStr)
    || sessions
        .filter(s => s.date_start && new Date(s.date_start) <= new Date())
        .sort((a, b) => new Date(b.date_start) - new Date(a.date_start))[0]

  if (!session) {
    logger.warn(`[AutoSeed] No matching OpenF1 session for ${raceDateStr}`)
    return false
  }

  const raceId = `${session.year}_${session.session_key}`

  if (await seedRepo.raceExists(raceId)) {
    logger.info(`[AutoSeed] ${raceId} already in Cassandra — skipping`)
    return true
  }

  logger.info(`[AutoSeed] Seeding ${raceId} — ${raceName}...`)
  const sessionName = session.meeting_name || raceName || raceId

  await seedRepo.insertRaceMeta(raceId, sessionName, session.session_key, session.year)

  // Drivers
  const drivers = await fetchJSON(`${OPENF1}/drivers?session_key=${session.session_key}`)
  await sleep(300)
  for (const d of drivers) {
    await seedRepo.insertDriver(
      raceId, String(d.driver_number), d.name_acronym || '', d.full_name || '', d.team_name || ''
    )
  }

  // Position feed (used to compute per-lap position below)
  const posByDriver = {}
  try {
    const allPos = await fetchJSON(`${OPENF1}/position?session_key=${session.session_key}`)
    await sleep(300)
    for (const p of allPos) {
      const k = String(p.driver_number)
      if (!posByDriver[k]) posByDriver[k] = []
      posByDriver[k].push({ t: new Date(p.date).getTime(), pos: p.position })
    }
    for (const arr of Object.values(posByDriver)) arr.sort((a, b) => a.t - b.t)
  } catch (_) {}

  // Laps per driver
  for (const driver of drivers) {
    const driverId = String(driver.driver_number)
    try {
      const laps = await fetchJSON(
        `${OPENF1}/laps?session_key=${session.session_key}&driver_number=${driver.driver_number}`
      )
      await sleep(200)
      const posHistory = posByDriver[driverId] || []
      for (const lap of laps) {
        if (!lap.lap_number || !lap.lap_duration) continue
        await seedRepo.insertLapTime(
          raceId, driverId, lap.lap_number,
          lap.lap_duration || 0, lap.duration_sector_1 || 0,
          lap.duration_sector_2 || 0, lap.duration_sector_3 || 0
        )
        if (lap.date_start && posHistory.length) {
          const lapEndMs = new Date(lap.date_start).getTime() + lap.lap_duration * 1000
          let pos = null
          for (const p of posHistory) {
            if (p.t <= lapEndMs) pos = p.pos
            else break
          }
          if (pos) await seedRepo.insertRacePosition(raceId, driverId, lap.lap_number, pos)
        }
      }
    } catch (_) { await sleep(200) }
  }

  // Pit stops
  try {
    const pits         = await fetchJSON(`${OPENF1}/pit?session_key=${session.session_key}`)
    await sleep(200)
    const pitsByDriver = {}
    for (const pit of pits) {
      if (!pit.driver_number || !pit.pit_duration || pit.pit_duration < 2) continue
      const k = String(pit.driver_number)
      if (!pitsByDriver[k]) pitsByDriver[k] = []
      pitsByDriver[k].push(pit)
    }
    for (const k of Object.keys(pitsByDriver)) {
      const sorted = pitsByDriver[k].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0))
      pitsByDriver[k] = sorted.filter((p, i) =>
        i === 0 || (p.lap_number || 0) - (sorted[i - 1].lap_number || 0) > 2
      )
    }
    for (const [driverId, stops] of Object.entries(pitsByDriver)) {
      for (let i = 0; i < stops.length; i++) {
        const pit = stops[i]
        await seedRepo.insertPitStop(
          raceId, driverId, i + 1, pit.lap_number || 0, pit.pit_duration || 0, pit.date || ''
        )
      }
    }
  } catch (_) {}

  // Stints
  try {
    const stints = await fetchJSON(`${OPENF1}/stints?session_key=${session.session_key}`)
    await sleep(200)
    for (const stint of stints) {
      if (!stint.driver_number || !stint.stint_number) continue
      await seedRepo.insertStint(
        raceId, String(stint.driver_number), stint.stint_number || 0,
        stint.compound || 'UNKNOWN', stint.lap_start || 0,
        stint.lap_end || 0, stint.tyre_age_at_start || 0
      )
    }
  } catch (_) {}

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

  // setTimeout max is ~24.8 days — reschedule daily if race is far away
  const MAX_TIMEOUT = 24 * 60 * 60_000
  if (next.seedTime - now > MAX_TIMEOUT) {
    scheduledTimeout = setTimeout(() => scheduleNextSeed(races), MAX_TIMEOUT)
    return
  }

  scheduledTimeout = setTimeout(async () => {
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
