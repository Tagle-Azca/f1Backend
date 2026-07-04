import * as raceRepository from '../repositories/raceRepository.js'
import * as seedRepo       from '../repositories/seedRepository.js'
import * as jolpica        from '../repositories/jolpicaRepository.js'
import logger              from '../utils/logger.js'

const OPENF1  = 'https://api.openf1.org/v1'
const HEADERS = { 'User-Agent': 'F1IntelligencePlatform/1.0', Accept: 'application/json' }

const sleep = ms => new Promise(r => setTimeout(r, ms))

// TODO: move to openf1Repository when it covers these seeding endpoints
async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.json()
}

function buildRaceResultsPayload(jr) {
  return {
    raceName: jr.raceName,
    date:     jr.date,
    time:     jr.time || null,
    url:      jr.url  || null,
    Circuit: {
      circuitId:   jr.Circuit?.circuitId,
      circuitName: jr.Circuit?.circuitName,
      Location:    jr.Circuit?.Location,
    },
    Results: jr.Results.map(r => ({
      position: r.position, points: r.points, grid: r.grid, laps: r.laps, status: r.status,
      Driver:      { driverId: r.Driver?.driverId, givenName: r.Driver?.givenName, familyName: r.Driver?.familyName },
      Constructor: { constructorId: r.Constructor?.constructorId, name: r.Constructor?.name },
      Time:        r.Time       || null,
      FastestLap:  r.FastestLap || null,
    })),
  }
}

// ── Cassandra seed helpers ────────────────────────────────────────────────────

export async function seedDrivers(raceId, sessionKey) {
  const drivers = await fetchJSON(`${OPENF1}/drivers?session_key=${sessionKey}`)
  await sleep(300)
  for (const d of drivers) {
    await seedRepo.insertDriver(
      raceId, String(d.driver_number), d.name_acronym || '', d.full_name || '', d.team_name || ''
    )
  }
  return drivers
}

async function buildPositionHistory(sessionKey) {
  const posByDriver = {}
  try {
    const allPos = await fetchJSON(`${OPENF1}/position?session_key=${sessionKey}`)
    await sleep(300)
    for (const p of allPos) {
      const k = String(p.driver_number)
      if (!posByDriver[k]) posByDriver[k] = []
      posByDriver[k].push({ t: new Date(p.date).getTime(), pos: p.position })
    }
    for (const arr of Object.values(posByDriver)) arr.sort((a, b) => a.t - b.t)
  } catch (_) {}
  return posByDriver
}

function matchLapToPosition(lap, posHistory) {
  if (!lap.date_start || !posHistory.length) return null
  const lapEndMs = new Date(lap.date_start).getTime() + lap.lap_duration * 1000
  let pos = null
  for (const p of posHistory) {
    if (p.t <= lapEndMs) pos = p.pos
    else break
  }
  return pos
}

export async function seedLapsAndPositions(raceId, sessionKey, drivers) {
  const posByDriver = await buildPositionHistory(sessionKey)

  for (const driver of drivers) {
    const driverId = String(driver.driver_number)
    try {
      const laps = await fetchJSON(
        `${OPENF1}/laps?session_key=${sessionKey}&driver_number=${driver.driver_number}`
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
        const pos = matchLapToPosition(lap, posHistory)
        if (pos) await seedRepo.insertRacePosition(raceId, driverId, lap.lap_number, pos)
      }
    } catch (_) { await sleep(200) }
  }
}

function deduplicatePits(pits) {
  const byDriver = {}
  for (const pit of pits) {
    if (!pit.driver_number || !pit.pit_duration || pit.pit_duration < 2) continue
    const k = String(pit.driver_number)
    if (!byDriver[k]) byDriver[k] = []
    byDriver[k].push(pit)
  }
  for (const k of Object.keys(byDriver)) {
    const sorted = byDriver[k].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0))
    byDriver[k] = sorted.filter((p, i) =>
      i === 0 || (p.lap_number || 0) - (sorted[i - 1].lap_number || 0) > 2
    )
  }
  return byDriver
}

export async function seedPitStops(raceId, sessionKey) {
  try {
    const pits     = await fetchJSON(`${OPENF1}/pit?session_key=${sessionKey}`)
    await sleep(200)
    const byDriver = deduplicatePits(pits)
    for (const [driverId, stops] of Object.entries(byDriver)) {
      for (let i = 0; i < stops.length; i++) {
        const pit = stops[i]
        await seedRepo.insertPitStop(
          raceId, driverId, i + 1, pit.lap_number || 0, pit.pit_duration || 0, pit.date || ''
        )
      }
    }
  } catch (_) {}
}

export async function seedStints(raceId, sessionKey) {
  try {
    const stints = await fetchJSON(`${OPENF1}/stints?session_key=${sessionKey}`)
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
}

// ── Race sync helpers ─────────────────────────────────────────────────────────

async function retrySkippedRounds(year, skippedRounds) {
  logger.info(`[SyncRaces] Retrying ${skippedRounds.length} skipped rounds individually…`)
  let count = 0
  for (const jr of skippedRounds) {
    try {
      const race = await jolpica.fetchRoundResults(year, jr.round)
      if (race?.Results?.length) {
        await raceRepository.upsertResults(race.season, race.round, buildRaceResultsPayload(race))
        count++
        logger.info(`[SyncRaces] ✓ R${race.round} ${race.raceName} (individual fetch)`)
      } else {
        logger.info(`[SyncRaces] R${jr.round} ${jr.raceName} — still no results on Jolpica`)
      }
      await sleep(300)
    } catch (e) {
      logger.warn(`[SyncRaces] Individual fetch failed for R${jr.round}: ${e.message}`)
    }
  }
  return count
}

async function syncSprintResults(year) {
  logger.info('[SyncRaces] Fetching sprint results…')
  const sraces = await jolpica.fetchSprintResultsByYear(year)
  for (const jr of sraces) {
    if (!jr.SprintResults?.length) continue
    await raceRepository.upsertResults(jr.season, jr.round, {
      // Included so a sprint synced before the race doesn't create a nameless doc
      raceName: jr.raceName,
      date:     jr.date,
      SprintResults: jr.SprintResults.map(r => ({
        position: r.position, points: r.points, grid: r.grid, laps: r.laps, status: r.status,
        Driver:      { driverId: r.Driver?.driverId, givenName: r.Driver?.givenName, familyName: r.Driver?.familyName },
        Constructor: { constructorId: r.Constructor?.constructorId, name: r.Constructor?.name },
      })),
    })
    logger.info(`[SyncRaces] ✓ Sprint R${jr.round} ${jr.raceName}`)
    await sleep(150)
  }
}

// ── Public service functions ──────────────────────────────────────────────────

export async function syncRacesForYear(year) {
  logger.info(`[SyncRaces] Fetching Jolpica results for ${year}…`)

  const races = await jolpica.fetchRaceResultsByYear(year)
  if (!races.length) {
    logger.warn('[SyncRaces] No races returned from Jolpica')
    return { updated: 0, skipped: 0 }
  }

  const today = new Date().toISOString().slice(0, 10)
  let updated = 0, skipped = 0
  const skippedRounds = []

  for (const jr of races) {
    if (!jr.Results?.length) {
      if (jr.date && jr.date <= today) skippedRounds.push(jr)
      skipped++
      continue
    }
    await raceRepository.upsertResults(jr.season, jr.round, buildRaceResultsPayload(jr))
    updated++
    await sleep(150)
  }

  if (skippedRounds.length) updated += await retrySkippedRounds(year, skippedRounds)

  try {
    await syncSprintResults(year)
  } catch (e) {
    logger.warn(`[SyncRaces] Sprint fetch failed (non-critical): ${e.message}`)
  }

  logger.info(`[SyncRaces] Done — ${updated} races updated, ${skipped} skipped (no results yet)`)
  return { updated, skipped }
}

/**
 * Schedules a burst of result syncs after a live race/sprint session ends.
 * Jolpica ingests results anywhere from minutes to a few hours after the
 * flag, so retry on a widening schedule; upserts make repeats harmless.
 */
const POST_SESSION_SYNC_DELAYS_MIN = [10, 45, 120, 300]
let postSessionSyncTimers = []

export function schedulePostSessionResultSync() {
  const year = String(new Date().getFullYear())

  for (const timer of postSessionSyncTimers) clearTimeout(timer)
  postSessionSyncTimers = POST_SESSION_SYNC_DELAYS_MIN.map(minutes =>
    setTimeout(() => {
      logger.info(`[SyncRaces] Post-session sync attempt (+${minutes}min)`)
      syncRacesForYear(year)
        .catch(err => logger.warn(`[SyncRaces] Post-session sync failed: ${err.message}`))
    }, minutes * 60_000)
  )

  logger.info(`[SyncRaces] Post-session syncs scheduled at +${POST_SESSION_SYNC_DELAYS_MIN.join(', +')} min`)
}

/**
 * Runs a full season sync only when Mongo is missing results for rounds
 * already raced. Cheap staleness check (one calendar request) so it can run
 * on every server start.
 */
export async function syncCurrentSeasonIfStale() {
  const year  = String(new Date().getFullYear())
  const today = new Date().toISOString().slice(0, 10)

  const calendar   = await jolpica.fetchCalendar(year)
  const pastRounds = calendar.filter(r => r.date && r.date <= today).map(r => r.round)

  const mongoRaces   = await raceRepository.findBySeasonSorted(year, 'round Results')
  const syncedRounds = new Set(mongoRaces.filter(r => r.Results?.length).map(r => r.round))

  const missing = pastRounds.filter(round => !syncedRounds.has(round))
  if (!missing.length) {
    logger.info('[SyncRaces] Season results up to date — no catch-up needed')
    return { updated: 0, skipped: 0 }
  }

  logger.info(`[SyncRaces] ${missing.length} past round(s) without results in Mongo — running catch-up sync`)
  return syncRacesForYear(year)
}

export async function seedRaceToCassandra(year, racesLimit, force) {
  if (!seedRepo.isCassandraConnected()) throw new Error('Cassandra not connected')

  logger.info(`[AdminSeed] triggered — year=${year} races=${racesLimit} force=${force}`)

  const years = year.split(',').map(y => y.trim())
  let sessions = []
  for (const yr of years) {
    const data = await fetchJSON(`${OPENF1}/sessions?session_name=Race&year=${yr}`)
    if (Array.isArray(data)) sessions = sessions.concat(data)
    await sleep(500)
  }

  const past = sessions
    .filter(s => s.date_start && new Date(s.date_start) <= new Date())
    .slice(-racesLimit)

  if (!past.length) {
    logger.warn('[AdminSeed] No past sessions found')
    return 'No past sessions found'
  }

  for (const session of past) {
    const raceId   = `${session.year}_${session.session_key}`
    const raceName = session.meeting_name || session.location || raceId

    if (!force && await seedRepo.raceExists(raceId)) {
      logger.info(`[AdminSeed] ${raceId} already seeded — skipping (pass force=true to override)`)
      continue
    }

    logger.info(`[AdminSeed] Seeding ${raceId} — ${raceName}`)
    await seedRepo.insertRaceMeta(raceId, raceName, session.session_key, session.year)

    const drivers = await seedDrivers(raceId, session.session_key)
    await seedLapsAndPositions(raceId, session.session_key, drivers)
    await seedPitStops(raceId, session.session_key)
    await seedStints(raceId, session.session_key)

    logger.info(`[AdminSeed] ✓ ${raceId} complete`)
  }

  logger.info('[AdminSeed] All done')
  return `Seeded ${past.length} session(s) for year=${year}`
}
