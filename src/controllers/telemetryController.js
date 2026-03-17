import { cassandraQuery, getCassandraClient } from '../config/cassandra.js'
import {
  sessionKeyFromRaceId,
  findLiveRaceSession,
  getLiveDrivers,
  getLiveLapTimes,
  getLivePitStops,
  getLiveRacePace,
  getLiveTireStrategy,
  getLivePositions,
} from '../services/openf1Live.js'

function cassandraUnavailable(res) {
  return res.status(503).json({ message: 'Cassandra not connected. Start Cassandra and seed data first.' })
}

/** Returns true if the raceId is NOT yet stored in race_meta (i.e. needs live proxy) */
async function isLiveRace(raceId) {
  try {
    const rows = await cassandraQuery(
      'SELECT race_id FROM race_meta WHERE race_id = ?',
      [raceId]
    )
    return rows.length === 0
  } catch {
    return false
  }
}

// ── Available races ────────────────────────────────────────────

export async function getAvailableRaces(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const rows = await cassandraQuery(
      'SELECT race_id, race_name FROM race_meta LIMIT 200'
    )
    const seeded = rows.map(r => ({ raceId: r.race_id, raceName: r.race_name }))

    // Check if there is a live/recent race not yet in Cassandra
    try {
      const live = await findLiveRaceSession()
      if (live && !seeded.some(r => r.raceId === live.raceId)) {
        seeded.push({ raceId: live.raceId, raceName: live.raceName, isLive: true })
      }
    } catch { /* live check is best-effort */ }

    res.json(seeded)
  } catch (err) { next(err) }
}

// ── Race drivers ───────────────────────────────────────────────

export async function getRaceDrivers(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId } = req.params

    if (await isLiveRace(raceId)) {
      const sessionKey = sessionKeyFromRaceId(raceId)
      if (!sessionKey) return res.json([])
      return res.json(await getLiveDrivers(sessionKey))
    }

    const rows = await cassandraQuery(
      'SELECT driver_id, acronym, full_name, team_name FROM race_drivers WHERE race_id = ?',
      [raceId]
    )
    res.json(rows.map(r => ({
      driverId: r.driver_id,
      acronym:  r.acronym,
      fullName: r.full_name,
      teamName: r.team_name,
    })))
  } catch (err) { next(err) }
}

// ── Lap times ─────────────────────────────────────────────────

export async function getLapTimes(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId, driverId } = req.params

    if (await isLiveRace(raceId)) {
      const sessionKey = sessionKeyFromRaceId(raceId)
      if (!sessionKey) return res.json([])
      return res.json(await getLiveLapTimes(sessionKey, driverId))
    }

    const rows = await cassandraQuery(
      `SELECT lap_number, lap_time, sector1, sector2, sector3
         FROM lap_times
        WHERE race_id = ? AND driver_id = ?
        ORDER BY lap_number ASC`,
      [raceId, driverId]
    )
    res.json(rows)
  } catch (err) { next(err) }
}

// ── Race pace ─────────────────────────────────────────────────

export async function getRacePace(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId } = req.params
    const driverIds  = (req.query.drivers || '').split(',').map(d => d.trim()).filter(Boolean)
    if (!driverIds.length) return res.json([])

    if (await isLiveRace(raceId)) {
      const sessionKey = sessionKeyFromRaceId(raceId)
      if (!sessionKey) return res.json([])
      return res.json(await getLiveRacePace(sessionKey, driverIds))
    }

    const results = await Promise.all(driverIds.map(async driverId => {
      const [laps, pits] = await Promise.all([
        cassandraQuery(
          `SELECT lap_number, lap_time, sector1, sector2, sector3
             FROM lap_times WHERE race_id = ? AND driver_id = ?
             ORDER BY lap_number ASC`,
          [raceId, driverId]
        ),
        cassandraQuery(
          `SELECT lap FROM pit_stops WHERE race_id = ? AND driver_id = ?`,
          [raceId, driverId]
        ),
      ])
      const pitLaps = new Set(pits.map(p => p.lap))
      return {
        driverId,
        laps: laps.map(r => ({
          lap:     r.lap_number,
          time:    r.lap_time,
          sector1: r.sector1,
          sector2: r.sector2,
          sector3: r.sector3,
          isPit:   pitLaps.has(r.lap_number),
        })),
      }
    }))

    res.json(results)
  } catch (err) { next(err) }
}

// ── Pit stops ─────────────────────────────────────────────────

export async function getPitStops(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId, driverId } = req.params

    if (await isLiveRace(raceId)) {
      const sessionKey = sessionKeyFromRaceId(raceId)
      if (!sessionKey) return res.json([])
      return res.json(await getLivePitStops(sessionKey, driverId))
    }

    const rows = await cassandraQuery(
      `SELECT stop_number, lap, duration, time
         FROM pit_stops
        WHERE race_id = ? AND driver_id = ?
        ORDER BY stop_number ASC`,
      [raceId, driverId]
    )
    res.json(rows)
  } catch (err) { next(err) }
}

// ── Race positions ─────────────────────────────────────────────

export async function getRacePositions(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId } = req.params

    if (await isLiveRace(raceId)) {
      const sessionKey = sessionKeyFromRaceId(raceId)
      if (!sessionKey) return res.json([])
      return res.json(await getLivePositions(sessionKey))
    }

    const [posRows, drivers, pits] = await Promise.all([
      cassandraQuery(
        `SELECT driver_id, lap, position FROM race_positions WHERE race_id = ? ALLOW FILTERING`,
        [raceId]
      ),
      cassandraQuery(
        'SELECT driver_id, acronym, team_name FROM race_drivers WHERE race_id = ?',
        [raceId]
      ),
      cassandraQuery(
        `SELECT driver_id, lap FROM pit_stops WHERE race_id = ? ALLOW FILTERING`,
        [raceId]
      ),
    ])

    if (!posRows.length) return res.json([])

    const driverMap    = new Map(drivers.map(d => [d.driver_id, d]))
    const pitsByDriver = new Map()
    for (const p of pits) {
      if (!pitsByDriver.has(p.driver_id)) pitsByDriver.set(p.driver_id, new Set())
      pitsByDriver.get(p.driver_id).add(p.lap)
    }

    const posByDriver = new Map()
    for (const row of posRows) {
      if (!posByDriver.has(row.driver_id)) posByDriver.set(row.driver_id, new Map())
      posByDriver.get(row.driver_id).set(row.lap, row.position)
    }

    const maxLap = Math.max(...posRows.map(r => r.lap))

    // Backfill lap 1 from first available lap
    for (const [, laps] of posByDriver) {
      if (!laps.has(1) && laps.size > 0) {
        const firstLap = Math.min(...laps.keys())
        laps.set(1, laps.get(firstLap))
      }
    }

    const lastLapPerDriver = new Map()
    for (const [dId, laps] of posByDriver) {
      lastLapPerDriver.set(dId, Math.max(...laps.keys()))
    }

    const allDriverIds    = [...new Set([...posByDriver.keys(), ...drivers.map(d => d.driver_id)])]
    const activeDriverIds = [...posByDriver.keys()]

    const positionsByLap = Array.from({ length: maxLap }, (_, i) => {
      const lap = i + 1
      const row = { lap }
      for (const dId of activeDriverIds) {
        const pos = posByDriver.get(dId)?.get(lap)
        if (pos != null) row[dId] = pos
      }
      return row
    })

    const result = allDriverIds.map(dId => {
      const d       = driverMap.get(dId)
      const pSet    = pitsByDriver.get(dId) || new Set()
      const lastLap = lastLapPerDriver.get(dId) ?? null
      const dns     = !posByDriver.has(dId)
      const dnf     = !dns && lastLap !== null && lastLap < maxLap - 1
      return {
        driverId: dId,
        acronym:  d?.acronym   || dId,
        teamName: d?.team_name || '',
        pitLaps:  [...pSet],
        dns,
        dnf,
        lastLap,
      }
    })

    res.json({ drivers: result, laps: positionsByLap, totalLaps: maxLap })
  } catch (err) { next(err) }
}

// ── Tire strategy ─────────────────────────────────────────────

export async function getTireStrategy(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId } = req.params

    if (await isLiveRace(raceId)) {
      const sessionKey = sessionKeyFromRaceId(raceId)
      if (!sessionKey) return res.json([])
      return res.json(await getLiveTireStrategy(sessionKey))
    }

    const [stints, drivers] = await Promise.all([
      cassandraQuery(
        `SELECT driver_id, stint_number, compound, lap_start, lap_end, tyre_age
           FROM stints
          WHERE race_id = ? ALLOW FILTERING`,
        [raceId]
      ),
      cassandraQuery(
        'SELECT driver_id, acronym, full_name, team_name FROM race_drivers WHERE race_id = ?',
        [raceId]
      ),
    ])

    const driverMap = new Map(drivers.map(d => [d.driver_id, d]))
    const byDriver  = new Map()

    for (const s of stints) {
      if (!byDriver.has(s.driver_id)) byDriver.set(s.driver_id, [])
      byDriver.get(s.driver_id).push({
        stintNumber: s.stint_number,
        compound:    s.compound,
        lapStart:    s.lap_start,
        lapEnd:      s.lap_end,
        tyreAge:     s.tyre_age,
      })
    }

    const result = []
    for (const [driverId, driverStints] of byDriver) {
      const d = driverMap.get(driverId)
      result.push({
        driverId,
        acronym:  d?.acronym   || driverId,
        fullName: d?.full_name || driverId,
        teamName: d?.team_name || '',
        stints:   driverStints.sort((a, b) => a.stintNumber - b.stintNumber),
      })
    }

    result.sort((a, b) => a.acronym.localeCompare(b.acronym))
    res.json(result)
  } catch (err) { next(err) }
}
