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
  getSafetyCarPeriods,
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

    const [lapRows, stintRows] = await Promise.all([
      cassandraQuery(
        `SELECT lap_number, lap_time, sector1, sector2, sector3
           FROM lap_times
          WHERE race_id = ? AND driver_id = ?
          ORDER BY lap_number ASC`,
        [raceId, driverId]
      ),
      cassandraQuery(
        `SELECT compound, lap_start, lap_end FROM stints WHERE race_id = ? AND driver_id = ?`,
        [raceId, driverId]
      ),
    ])

    res.json(lapRows.map(r => {
      const stint = stintRows.find(s => r.lap_number >= s.lap_start && r.lap_number <= s.lap_end)
      return { ...r, compound: stint?.compound?.toUpperCase() || null }
    }))
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

// ── Race info (total laps, used for DNS/DNF detection) ─────────

export async function getRaceInfo(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { raceId } = req.params
    const [stintRows, posRows] = await Promise.all([
      cassandraQuery(
        'SELECT lap_end FROM stints WHERE race_id = ? ALLOW FILTERING',
        [raceId]
      ),
      cassandraQuery(
        'SELECT driver_id, lap FROM race_positions WHERE race_id = ? ALLOW FILTERING',
        [raceId]
      ),
    ])

    const valid     = stintRows.filter(r => r.lap_end != null).map(r => r.lap_end)
    const totalLaps = valid.length ? Math.max(...valid) : null

    // Build per-driver last-lap map from race positions
    const lastLapMap = new Map()
    for (const r of posRows) {
      if ((lastLapMap.get(r.driver_id) ?? 0) < r.lap) lastLapMap.set(r.driver_id, r.lap)
    }

    const maxLap = posRows.length ? Math.max(...posRows.map(r => r.lap)) : (totalLaps ?? 0)

    const driverStatuses = {}
    for (const [dId, lastLap] of lastLapMap) {
      driverStatuses[dId] = lastLap < maxLap - 1 ? 'DNF' : 'Finished'
    }

    res.json({ totalLaps, driverStatuses })
  } catch (err) { next(err) }
}

// ── Safety Car / VSC periods ───────────────────────────────────

export async function getSafetyCar(req, res, next) {
  try {
    const sessionKey = sessionKeyFromRaceId(req.params.raceId)
    if (!sessionKey) return res.json([])
    res.json(await getSafetyCarPeriods(sessionKey))
  } catch (err) { next(err) }
}

// ── Team pace (constructor profile) ───────────────────────────

export async function getTeamPace(req, res, next) {
  if (!getCassandraClient()) return cassandraUnavailable(res)
  try {
    const { teamName, year, raceId: requestedRaceId } = req.query
    if (!teamName || !year) return res.status(400).json({ message: 'teamName and year required' })

    const metaRows = await cassandraQuery(
      'SELECT race_id, race_name FROM race_meta WHERE year = ? ALLOW FILTERING',
      [parseInt(year)]
    )
    if (!metaRows.length) return res.json(null)

    const sortedRaces = [...metaRows].sort((a, b) => {
      const key = r => parseInt(r.race_id.split('_')[1] || 0)
      return key(b) - key(a)
    })

    // Find all races that have this team, and the target race (requested or most recent)
    const keywords = teamName.toLowerCase().split(' ').filter(w => w.length > 3)
    let teamDrivers = [], foundRaceId = null, foundRaceName = null
    const availableRaces = []

    for (const meta of sortedRaces) {
      const rows = await cassandraQuery(
        'SELECT driver_id, acronym, full_name, team_name FROM race_drivers WHERE race_id = ?',
        [meta.race_id]
      )
      const matched = rows.filter(d =>
        keywords.some(kw => d.team_name?.toLowerCase().includes(kw))
      )
      if (matched.length >= 1) {
        availableRaces.push({ raceId: meta.race_id, raceName: meta.race_name })
        if (!foundRaceId && (!requestedRaceId || meta.race_id === requestedRaceId)) {
          teamDrivers = matched; foundRaceId = meta.race_id; foundRaceName = meta.race_name
        }
      }
    }
    if (!teamDrivers.length) return res.json(null)

    // Fetch lap times + stints for team drivers + all drivers (field avg)
    const allDriverRows = await cassandraQuery(
      'SELECT driver_id FROM race_drivers WHERE race_id = ?', [foundRaceId]
    )

    const fieldLapMap = new Map()     // lap → [times]
    const fieldS = { s1: 0, s2: 0, s3: 0, n: 0 }

    await Promise.all(allDriverRows.map(async d => {
      const rows = await cassandraQuery(
        'SELECT lap_number, lap_time, sector1, sector2, sector3 FROM lap_times WHERE race_id = ? AND driver_id = ? ORDER BY lap_number ASC',
        [foundRaceId, d.driver_id]
      )
      for (const r of rows) {
        if (!r.lap_time || r.lap_time <= 0) continue
        if (!fieldLapMap.has(r.lap_number)) fieldLapMap.set(r.lap_number, [])
        fieldLapMap.get(r.lap_number).push(r.lap_time)
        if (r.sector1 && r.sector2 && r.sector3) {
          fieldS.s1 += r.sector1; fieldS.s2 += r.sector2; fieldS.s3 += r.sector3; fieldS.n++
        }
      }
    }))

    // Median lap time per lap (robust vs outliers)
    const fieldAvgPerLap = [...fieldLapMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([lap, times]) => {
        const s = [...times].sort((a, b) => a - b)
        return { lap, avg: Math.round(s[Math.floor(s.length / 2)] * 1000) / 1000 }
      })

    // Overall field median (IQR-filtered)
    const allTimes = fieldAvgPerLap.map(f => f.avg).sort((a, b) => a - b)
    const p25 = allTimes[Math.floor(allTimes.length * 0.25)]
    const p75 = allTimes[Math.floor(allTimes.length * 0.75)]
    const iqr = p75 - p25
    const clean = allTimes.filter(t => t >= p25 - 1.5 * iqr && t <= p75 + 1.5 * iqr)
    const fieldAvgLap = clean.length
      ? Math.round(clean.reduce((a, b) => a + b, 0) / clean.length * 1000) / 1000
      : null

    // Per-driver lap data with compound overlay
    const driverPace = await Promise.all(teamDrivers.map(async d => {
      const [laps, stints] = await Promise.all([
        cassandraQuery(
          'SELECT lap_number, lap_time, sector1, sector2, sector3 FROM lap_times WHERE race_id = ? AND driver_id = ? ORDER BY lap_number ASC',
          [foundRaceId, d.driver_id]
        ),
        cassandraQuery(
          'SELECT compound, lap_start, lap_end FROM stints WHERE race_id = ? AND driver_id = ?',
          [foundRaceId, d.driver_id]
        ),
      ])
      return {
        driverId: d.driver_id, acronym: d.acronym, fullName: d.full_name,
        laps: laps
          .filter(l => l.lap_time > 0)
          .map(l => {
            const stint = stints.find(s => l.lap_number >= s.lap_start && l.lap_number <= s.lap_end)
            return {
              lap: l.lap_number,
              time: Math.round(l.lap_time * 1000) / 1000,
              s1: l.sector1, s2: l.sector2, s3: l.sector3,
              compound: stint?.compound || null,
            }
          }),
      }
    }))

    // Team sector averages vs field
    const teamS = { s1: 0, s2: 0, s3: 0, n: 0 }
    for (const d of driverPace) {
      for (const l of d.laps) {
        if (l.s1 && l.s2 && l.s3) {
          teamS.s1 += l.s1; teamS.s2 += l.s2; teamS.s3 += l.s3; teamS.n++
        }
      }
    }

    let sectorDominance = null
    if (teamS.n > 0 && fieldS.n > 0) {
      const tAvg = [teamS.s1 / teamS.n, teamS.s2 / teamS.n, teamS.s3 / teamS.n]
      const fAvg = [fieldS.s1 / fieldS.n, fieldS.s2 / fieldS.n, fieldS.s3 / fieldS.n]
      sectorDominance = [1, 2, 3].map((s, i) => ({
        sector: `S${s}`,
        teamAvg:  Math.round(tAvg[i] * 1000) / 1000,
        fieldAvg: Math.round(fAvg[i] * 1000) / 1000,
        delta:    Math.round((tAvg[i] - fAvg[i]) * 1000) / 1000, // negative = faster
      }))
    }

    // availableRaces sorted oldest → newest for the selector
    res.json({
      raceId: foundRaceId, raceName: foundRaceName,
      availableRaces: availableRaces.reverse(),
      drivers: driverPace, fieldAvgLap, fieldAvgPerLap, sectorDominance,
    })
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
