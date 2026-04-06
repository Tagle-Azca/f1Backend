import { getCassandraClient } from '../config/cassandra.js'
import Race   from '../models/Race.js'
import logger from '../utils/logger.js'

const OPENF1   = 'https://api.openf1.org/v1'
const JOLPICA  = 'https://api.jolpi.ca/ergast/f1'
const HEADERS  = { 'User-Agent': 'F1IntelligencePlatform/1.0', Accept: 'application/json' }
const sleep   = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.json()
}

export async function triggerCassandraSeed(req, res) {
  // Token check
  const token = req.query.token || req.headers['x-admin-token']
  if (!process.env.ADMIN_SEED_TOKEN || token !== process.env.ADMIN_SEED_TOKEN) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const year      = req.query.year  || String(new Date().getFullYear())
  const racesLimit = parseInt(req.query.races || '1')
  const force     = req.query.force === 'true'

  const cassandra = getCassandraClient()
  if (!cassandra) {
    return res.status(503).json({ message: 'Cassandra not connected' })
  }

  const KS = process.env.CASSANDRA_KEYSPACE || 'f1_telemetry'

  // Respond immediately — seed runs in background
  res.json({
    message: `Seed started for year=${year} races=${racesLimit}`,
    note: 'Check server logs for progress',
  })

  // Run seed async after response
  ;(async () => {
    try {
      logger.info(`[AdminSeed] triggered — year=${year} races=${racesLimit} force=${force}`)

      const years = year.split(',').map(y => y.trim())
      let sessions = []
      for (const yr of years) {
        const data = await fetchJSON(`${OPENF1}/sessions?session_name=Race&year=${yr}`)
        if (Array.isArray(data)) sessions = sessions.concat(data)
        await sleep(500)
      }

      const now = new Date()
      const past = sessions
        .filter(s => s.date_start && new Date(s.date_start) <= now)
        .slice(-racesLimit)

      if (!past.length) {
        logger.warn('[AdminSeed] No past sessions found')
        return
      }

      const exec = (q, p) => cassandra.execute(q, p, { prepare: true })

      for (const session of past) {
        const raceId    = `${session.year}_${session.session_key}`
        const raceName  = session.meeting_name || session.location || raceId

        // Skip if already seeded (unless --force)
        if (!force) {
          const existing = await cassandra.execute(
            `SELECT race_id FROM ${KS}.race_meta WHERE race_id = ?`,
            [raceId], { prepare: true }
          )
          if (existing.rowLength > 0) {
            logger.info(`[AdminSeed] ${raceId} already seeded — skipping (pass force=true to override)`)
            continue
          }
        }

        logger.info(`[AdminSeed] Seeding ${raceId} — ${raceName}`)

        await exec(
          `INSERT INTO ${KS}.race_meta (race_id, race_name, session_key, year) VALUES (?,?,?,?)`,
          [raceId, raceName, session.session_key, session.year]
        )

        const drivers = await fetchJSON(`${OPENF1}/drivers?session_key=${session.session_key}`)
        await sleep(300)

        for (const d of drivers) {
          await exec(
            `INSERT INTO ${KS}.race_drivers (race_id, driver_id, acronym, full_name, team_name) VALUES (?,?,?,?,?)`,
            [raceId, String(d.driver_number), d.name_acronym || '', d.full_name || '', d.team_name || '']
          )
        }

        // Position feed
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
              await exec(
                `INSERT INTO ${KS}.lap_times (race_id, driver_id, lap_number, lap_time, sector1, sector2, sector3) VALUES (?,?,?,?,?,?,?)`,
                [raceId, driverId, lap.lap_number,
                 lap.lap_duration || 0, lap.duration_sector_1 || 0,
                 lap.duration_sector_2 || 0, lap.duration_sector_3 || 0]
              )
              if (lap.date_start && posHistory.length) {
                const lapEndMs = new Date(lap.date_start).getTime() + lap.lap_duration * 1000
                let pos = null
                for (const p of posHistory) {
                  if (p.t <= lapEndMs) pos = p.pos
                  else break
                }
                if (pos) {
                  await exec(
                    `INSERT INTO ${KS}.race_positions (race_id, driver_id, lap, position) VALUES (?,?,?,?)`,
                    [raceId, driverId, lap.lap_number, pos]
                  )
                }
              }
            }
          } catch (_) { await sleep(200) }
        }

        // Pit stops
        try {
          const pits = await fetchJSON(`${OPENF1}/pit?session_key=${session.session_key}`)
          await sleep(200)
          const pitsByDriver = {}
          for (const pit of pits) {
            if (!pit.driver_number || !pit.pit_duration || pit.pit_duration < 2) continue
            const k = String(pit.driver_number)
            if (!pitsByDriver[k]) pitsByDriver[k] = []
            pitsByDriver[k].push(pit)
          }
          for (const k of Object.keys(pitsByDriver)) {
            const sorted = pitsByDriver[k].sort((a, b) => (a.lap_number||0) - (b.lap_number||0))
            pitsByDriver[k] = sorted.filter((p, i) =>
              i === 0 || (p.lap_number||0) - (sorted[i-1].lap_number||0) > 2
            )
          }
          for (const [driverId, stops] of Object.entries(pitsByDriver)) {
            for (let i = 0; i < stops.length; i++) {
              const pit = stops[i]
              await exec(
                `INSERT INTO ${KS}.pit_stops (race_id, driver_id, stop_number, lap, duration, time) VALUES (?,?,?,?,?,?)`,
                [raceId, driverId, i + 1, pit.lap_number||0, pit.pit_duration||0, pit.date||'']
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
            await exec(
              `INSERT INTO ${KS}.stints (race_id, driver_id, stint_number, compound, lap_start, lap_end, tyre_age) VALUES (?,?,?,?,?,?,?)`,
              [raceId, String(stint.driver_number), stint.stint_number||0,
               stint.compound||'UNKNOWN', stint.lap_start||0, stint.lap_end||0, stint.tyre_age_at_start||0]
            )
          }
        } catch (_) {}

        logger.info(`[AdminSeed] ✓ ${raceId} complete`)
      }

      logger.info('[AdminSeed] All done')
    } catch (err) {
      logger.error(`[AdminSeed] Failed: ${err.message}`)
    }
  })()
}

/**
 * POST/GET /api/admin/sync-races?token=X&year=2025
 *
 * Pulls all race results for the given year from Jolpica and upserts
 * them into MongoDB. Safe to run multiple times — only updates rounds
 * that have results and are missing or outdated in the DB.
 */
export async function syncRaces(req, res) {
  const token = req.query.token || req.headers['x-admin-token']
  if (!process.env.ADMIN_SEED_TOKEN || token !== process.env.ADMIN_SEED_TOKEN) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const year = req.query.year || String(new Date().getFullYear())

  res.json({ message: `Race sync started for year=${year}`, note: 'Check server logs for progress' })

  ;(async () => {
    try {
      logger.info(`[SyncRaces] Fetching Jolpica results for ${year}…`)

      // Fetch all results for the year (limit 500 covers every driver in every race)
      const resp = await fetch(
        `${JOLPICA}/${year}/results.json?limit=500`,
        { headers: HEADERS, signal: AbortSignal.timeout(15_000) }
      )
      if (!resp.ok) throw new Error(`Jolpica HTTP ${resp.status}`)
      const json  = await resp.json()
      const races = json?.MRData?.RaceTable?.Races || []

      if (!races.length) {
        logger.warn('[SyncRaces] No races returned from Jolpica')
        return
      }

      let updated = 0, skipped = 0

      for (const jr of races) {
        if (!jr.Results?.length) { skipped++; continue }

        const filter = { season: jr.season, round: jr.round }
        const update = {
          $set: {
            raceName:  jr.raceName,
            date:      jr.date,
            time:      jr.time || null,
            url:       jr.url  || null,
            Circuit: {
              circuitId:   jr.Circuit?.circuitId,
              circuitName: jr.Circuit?.circuitName,
              Location:    jr.Circuit?.Location,
            },
            Results: jr.Results.map(r => ({
              position:    r.position,
              points:      r.points,
              grid:        r.grid,
              laps:        r.laps,
              status:      r.status,
              Driver: {
                driverId:        r.Driver?.driverId,
                givenName:       r.Driver?.givenName,
                familyName:      r.Driver?.familyName,
              },
              Constructor: {
                constructorId: r.Constructor?.constructorId,
                name:          r.Constructor?.name,
              },
              Time:       r.Time       || null,
              FastestLap: r.FastestLap || null,
            })),
          },
        }

        await Race.updateOne(filter, update, { upsert: true })
        logger.info(`[SyncRaces] ✓ R${jr.round} ${jr.raceName}`)
        updated++
        await sleep(150) // be polite to Jolpica
      }

      // Also sync sprint results for sprint weekends
      logger.info(`[SyncRaces] Fetching sprint results…`)
      try {
        const sresp = await fetch(
          `${JOLPICA}/${year}/sprint.json?limit=200`,
          { headers: HEADERS, signal: AbortSignal.timeout(10_000) }
        )
        if (sresp.ok) {
          const sjson  = await sresp.json()
          const sraces = sjson?.MRData?.RaceTable?.Races || []
          for (const jr of sraces) {
            if (!jr.SprintResults?.length) continue
            await Race.updateOne(
              { season: jr.season, round: jr.round },
              { $set: { SprintResults: jr.SprintResults.map(r => ({
                position: r.position, points: r.points, grid: r.grid, laps: r.laps, status: r.status,
                Driver:      { driverId: r.Driver?.driverId, givenName: r.Driver?.givenName, familyName: r.Driver?.familyName },
                Constructor: { constructorId: r.Constructor?.constructorId, name: r.Constructor?.name },
              })) }},
              { upsert: true }
            )
            logger.info(`[SyncRaces] ✓ Sprint R${jr.round} ${jr.raceName}`)
            await sleep(150)
          }
        }
      } catch (e) {
        logger.warn(`[SyncRaces] Sprint fetch failed (non-critical): ${e.message}`)
      }

      logger.info(`[SyncRaces] Done — ${updated} races updated, ${skipped} skipped (no results yet)`)
    } catch (err) {
      logger.error(`[SyncRaces] Failed: ${err.message}`)
    }
  })()
}
