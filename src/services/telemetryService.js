import {
  sessionKeyFromRaceId,
  findLiveRaceSession,
  findLiveSession,
  clearLiveSessionCache,
  getLiveTimingTower,
} from './openf1Live.js'
import {
  getLiveDrivers,
  getLiveLapTimes,
  getLivePitStops,
  getLiveRacePace,
  getLiveTireStrategy,
  getLivePositions,
  getSafetyCarPeriods,
} from './openf1Telemetry.js'
import { getOpenF1RaceSessions, fetchPositions } from '../repositories/openf1Repository.js'
import {
  getF1LiveClassification,
  isF1LiveConnected,
  getLastSessionSnapshot,
} from './f1LiveTiming.js'
import * as repo from '../repositories/telemetryRepository.js'

// ── Available races ────────────────────────────────────────────────────────────

export async function getAvailableRaces() {
  // Cassandra races (empty array if Cassandra is down)
  const rows   = await repo.queryAvailableRaces().catch(() => [])
  const seeded = rows.map(r => ({ raceId: r.race_id, raceName: r.race_name }))
  const ids    = new Set(seeded.map(r => r.raceId))

  // OpenF1 race catalogue — fills gaps + provides dates for all races
  const dateMap = new Map()  // raceId → date_start ISO string
  try {
    const of1Sessions = await getOpenF1RaceSessions()
    for (const s of of1Sessions) {
      const raceId = `${s.year}_${s.session_key}`
      if (s.date_start) dateMap.set(raceId, s.date_start)
      if (!ids.has(raceId)) {
        seeded.push({ raceId, raceName: s.meeting_name || raceId })
        ids.add(raceId)
      }
    }
  } catch { /* best-effort */ }

  // Attach date to every entry (Cassandra-seeded ones included)
  for (const r of seeded) {
    if (dateMap.has(r.raceId)) r.date = dateMap.get(r.raceId)
  }

  // Live race currently happening
  try {
    const live = await findLiveRaceSession()
    if (live && !ids.has(live.raceId))
      seeded.push({ raceId: live.raceId, raceName: live.raceName, isLive: true })
  } catch { /* best-effort */ }

  return seeded
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** OpenF1 session keys are always ≥ 1000. Round numbers (1, 2, 3…) are not valid. */
function validSessionKey(raceId) {
  const key = sessionKeyFromRaceId(raceId)
  return key !== null && key >= 1000 ? key : null
}

// ── Race drivers ───────────────────────────────────────────────────────────────

export async function getRaceDrivers(raceId) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    return key ? getLiveDrivers(key) : []
  }
  const rows = await repo.queryRaceDrivers(raceId)
  return rows.map(r => ({ driverId: r.driver_id, acronym: r.acronym, fullName: r.full_name, teamName: r.team_name }))
}

// ── Lap times ─────────────────────────────────────────────────────────────────

// In-laps / out-laps / VSC-pit laps can record wall-clock time (the timer keeps
// running while the car sits in the pit lane).  Anything above ~5 min is noise.
const MAX_LAP_SECONDS = 300

export async function getLapTimes(raceId, driverId) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    return key ? getLiveLapTimes(key, driverId) : []
  }
  const [laps, stints] = await Promise.all([
    repo.queryLapTimes(raceId, driverId),
    repo.queryStints(raceId, driverId),
  ])
  return laps
    .filter(r => r.lap_time > 0 && r.lap_time <= MAX_LAP_SECONDS)
    .map(r => {
      const stint = stints.find(s => r.lap_number >= s.lap_start && r.lap_number <= s.lap_end)
      return { ...r, compound: stint?.compound?.toUpperCase() || null }
    })
}

// ── Race pace ─────────────────────────────────────────────────────────────────

export async function getRacePace(raceId, driverIds) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    return key ? getLiveRacePace(key, driverIds) : []
  }
  return Promise.all(driverIds.map(async driverId => {
    const [laps, pits] = await Promise.all([
      repo.queryLapTimes(raceId, driverId),
      repo.queryPitLaps(raceId, driverId),
    ])
    const pitLaps = new Set(pits.map(p => p.lap))
    return {
      driverId,
      laps: laps.map(r => ({
        lap: r.lap_number, time: r.lap_time,
        sector1: r.sector1, sector2: r.sector2, sector3: r.sector3,
        isPit: pitLaps.has(r.lap_number),
      })),
    }
  }))
}

// ── Pit stops ─────────────────────────────────────────────────────────────────

export async function getPitStops(raceId, driverId) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    return key ? getLivePitStops(key, driverId) : []
  }
  return repo.queryPitStops(raceId, driverId)
}

// ── Race positions ────────────────────────────────────────────────────────────

export async function getRacePositions(raceId) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    return key ? getLivePositions(key) : []
  }
  const [posRows, drivers, pits] = await Promise.all([
    repo.queryRacePositions(raceId),
    repo.queryRaceDrivers(raceId),
    repo.queryAllPitLaps(raceId),
  ])
  if (!posRows.length) return []

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
  for (const [, laps] of posByDriver) {
    if (!laps.has(1) && laps.size > 0) {
      const firstLap = Math.min(...laps.keys())
      laps.set(1, laps.get(firstLap))
    }
  }

  const lastLapPerDriver = new Map()
  for (const [dId, laps] of posByDriver) lastLapPerDriver.set(dId, Math.max(...laps.keys()))

  const allDriverIds    = [...new Set([...posByDriver.keys(), ...drivers.map(d => d.driver_id)])]
  const activeDriverIds = [...posByDriver.keys()]

  const laps = Array.from({ length: maxLap }, (_, i) => {
    const lap = i + 1
    const row = { lap }
    for (const dId of activeDriverIds) {
      const pos = posByDriver.get(dId)?.get(lap)
      if (pos != null) row[dId] = pos
    }
    return row
  })

  const driverList = allDriverIds.map(dId => {
    const d       = driverMap.get(dId)
    const lastLap = lastLapPerDriver.get(dId) ?? null
    const dns     = !posByDriver.has(dId)
    return {
      driverId: dId,
      acronym:  d?.acronym   || dId,
      teamName: d?.team_name || '',
      pitLaps:  [...(pitsByDriver.get(dId) || new Set())],
      dns,
      dnf: !dns && lastLap !== null && lastLap < maxLap - 1,
      lastLap,
    }
  })

  return { drivers: driverList, laps, totalLaps: maxLap }
}

// ── Race info ─────────────────────────────────────────────────────────────────

export async function getRaceInfo(raceId) {
  const [stintRows, posRows] = await Promise.all([
    repo.queryStintLapEnds(raceId),
    repo.queryRacePositions(raceId),
  ])
  const valid     = stintRows.filter(r => r.lap_end != null).map(r => r.lap_end)
  const totalLaps = valid.length ? Math.max(...valid) : null
  const maxLap    = posRows.length ? Math.max(...posRows.map(r => r.lap)) : (totalLaps ?? 0)

  const lastLapMap = new Map()
  for (const r of posRows)
    if ((lastLapMap.get(r.driver_id) ?? 0) < r.lap) lastLapMap.set(r.driver_id, r.lap)

  const driverStatuses = {}
  for (const [dId, lastLap] of lastLapMap)
    driverStatuses[dId] = lastLap < maxLap - 1 ? 'DNF' : 'Finished'

  return { totalLaps, driverStatuses }
}

// ── Safety car ────────────────────────────────────────────────────────────────

export async function getSafetyCar(raceId) {
  const key = validSessionKey(raceId)
  return key ? getSafetyCarPeriods(key) : []
}

// ── Tire strategy ─────────────────────────────────────────────────────────────

export async function getTireStrategy(raceId) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    return key ? getLiveTireStrategy(key) : []
  }
  const [stints, drivers] = await Promise.all([
    repo.queryAllStints(raceId),
    repo.queryRaceDrivers(raceId),
  ])
  const driverMap = new Map(drivers.map(d => [d.driver_id, d]))
  const byDriver  = new Map()
  for (const s of stints) {
    if (!byDriver.has(s.driver_id)) byDriver.set(s.driver_id, [])
    byDriver.get(s.driver_id).push({
      stintNumber: s.stint_number, compound: s.compound,
      lapStart: s.lap_start, lapEnd: s.lap_end, tyreAge: s.tyre_age,
    })
  }
  return [...byDriver.entries()]
    .map(([driverId, driverStints]) => {
      const d = driverMap.get(driverId)
      return {
        driverId,
        acronym:  d?.acronym   || driverId,
        fullName: d?.full_name || driverId,
        teamName: d?.team_name || '',
        stints:   driverStints.sort((a, b) => a.stintNumber - b.stintNumber),
      }
    })
    .sort((a, b) => a.acronym.localeCompare(b.acronym))
}

// ── Winner tire strategy ──────────────────────────────────────────────────────

export function resolveHistoricalWinnerId(stints, posRows, totalLaps) {
  // 1. Scan backwards from final lap for position=1 (Cassandra stores as int or string)
  let winnerId = null
  if (posRows.length) {
    const maxLap = Math.max(...posRows.map(r => r.lap))
    for (let lap = maxLap; lap >= maxLap - 5 && !winnerId; lap--) {
      const p1 = posRows.find(r => r.lap === lap && Number(r.position) === 1)
      if (p1) winnerId = p1.driver_id
    }
  }
  // 2. Driver whose last stint ends exactly at totalLaps
  if (!winnerId && totalLaps) {
    const lastStint = stints
      .filter(s => s.lap_end === totalLaps)
      .sort((a, b) => b.stint_number - a.stint_number)[0]
    if (lastStint) winnerId = lastStint.driver_id
  }
  // 3. Driver with highest lap_end (most laps completed)
  if (!winnerId) {
    const maxPerDriver = new Map()
    for (const s of stints) {
      if (s.lap_end == null) continue
      if (!maxPerDriver.has(s.driver_id) || maxPerDriver.get(s.driver_id) < s.lap_end)
        maxPerDriver.set(s.driver_id, s.lap_end)
    }
    if (maxPerDriver.size)
      winnerId = [...maxPerDriver.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
  return winnerId
}

export async function getWinnerStrategy(raceId) {
  if (await repo.isLiveRace(raceId)) {
    const key = validSessionKey(raceId)
    if (!key) return null
    const [strategy, liveClass] = await Promise.all([
      getLiveTireStrategy(key),
      Promise.resolve(getF1LiveClassification()),
    ])
    if (!strategy.length) return null
    const p1Num = liveClass?.classification?.find(d => d.position === 1)?.driverNum
    let winner  = p1Num ? strategy.find(d => d.driverId === String(p1Num)) : null

    // No live classification — past session not yet in Cassandra: resolve from OpenF1 positions
    if (!winner) {
      try {
        const positions = await fetchPositions(key)
        const p1entries = positions.filter(p => p.position === 1)
        if (p1entries.length) {
          const latest = p1entries.sort((a, b) => new Date(b.date) - new Date(a.date))[0]
          winner = strategy.find(d => d.driverId === String(latest.driver_number))
        }
      } catch {}
    }

    if (!winner) winner = strategy[0]
    if (!winner) return null
    const totalLaps = liveClass?.totalLaps ||
      (winner.stints.at(-1)?.lapEnd ?? null)
    return {
      driverId: winner.driverId, acronym: winner.acronym,
      fullName: winner.fullName, teamName: winner.teamName,
      totalLaps,
      stints: winner.stints.map(s => ({
        stintNumber: s.stintNumber,
        compound:    (s.compound || 'UNKNOWN').toUpperCase(),
        lapStart:    s.lapStart, lapEnd: s.lapEnd,
        laps:        s.lapEnd != null && s.lapStart != null ? s.lapEnd - s.lapStart + 1 : null,
        tyreAge:     s.tyreAge,
      })),
    }
  }

  const [stints, drivers, posRows] = await Promise.all([
    repo.queryAllStints(raceId),
    repo.queryRaceDrivers(raceId),
    repo.queryRacePositions(raceId),
  ])
  if (!stints.length) return null

  const validEnds = stints.filter(s => s.lap_end != null).map(s => s.lap_end)
  const totalLaps = validEnds.length ? Math.max(...validEnds) : null
  const winnerId  = resolveHistoricalWinnerId(stints, posRows, totalLaps)
  if (!winnerId) return null

  const d = drivers.find(dr => dr.driver_id === winnerId)
  return {
    driverId: winnerId, acronym: d?.acronym || winnerId,
    fullName: d?.full_name || winnerId, teamName: d?.team_name || '',
    totalLaps,
    stints: stints
      .filter(s => s.driver_id === winnerId)
      .map(s => ({
        stintNumber: s.stint_number,
        compound:    (s.compound || 'UNKNOWN').toUpperCase(),
        lapStart:    s.lap_start, lapEnd: s.lap_end,
        laps:        s.lap_end != null && s.lap_start != null ? s.lap_end - s.lap_start + 1 : null,
        tyreAge:     s.tyre_age,
      }))
      .sort((a, b) => a.stintNumber - b.stintNumber),
  }
}

// ── Live timing tower ─────────────────────────────────────────────────────────

export async function getTimingTower() {
  // Primary: F1 official SignalR feed (real-time, sector colors from F1 itself)
  if (isF1LiveConnected()) {
    const live = getF1LiveClassification()
    if (live?.classification?.length) {
      const drivers = live.classification.map(d => ({
        position:   d.position,
        driverNum:  d.driverNum,
        acronym:    d.acronym,
        teamName:   d.teamName,
        teamColor:  d.teamColor,
        bestLapStr: d.bestLap   || null,
        gapStr:     d.statLabel === 'gap'
          ? (d.stat || 'LEADER')
          : (d.statLabel || 'LEADER'),
        inPit:      d.inPit     || false,
        retired:    d.retired   || false,
        compound:   d.compound  || null,
        throttle:   d.throttle  ?? null,
        brake:      d.brake     ?? null,
        gear:       d.gear      ?? null,
        s1: d.sectors?.[0]?.value ? { time: d.sectors[0].value, color: d.sectors[0].status } : null,
        s2: d.sectors?.[1]?.value ? { time: d.sectors[1].value, color: d.sectors[1].status } : null,
        s3: d.sectors?.[2]?.value ? { time: d.sectors[2].value, color: d.sectors[2].status } : null,
      }))
      return {
        source:      'f1live',
        sessionName: live.sessionName,
        raceName:    live.raceName,
        isRaceType:  live.isRaceType,
        completed:   live.finished || false,
        trackStatus: live.trackStatus,
        currentLap:  live.currentLap,
        totalLaps:   live.totalLaps,
        updatedAt:   new Date().toISOString(),
        drivers,
      }
    }
  }

  // Fallback: last completed session snapshot (shown as "completed")
  const snapshot = getLastSessionSnapshot()
  if (snapshot?.classification?.length) {
    const drivers = snapshot.classification.map(d => ({
      position:   d.position,
      driverNum:  d.driverNum,
      acronym:    d.acronym,
      teamName:   d.teamName,
      teamColor:  d.teamColor,
      compound:   d.compound   || null,
      throttle:   null,
      brake:      null,
      bestLapStr: d.bestLap    || null,
      gapStr:     d.statLabel === 'gap' ? (d.stat || 'LEADER') : (d.statLabel || 'LEADER'),
      s1: d.sectors?.[0]?.value ? { time: d.sectors[0].value, color: d.sectors[0].status } : null,
      s2: d.sectors?.[1]?.value ? { time: d.sectors[1].value, color: d.sectors[1].status } : null,
      s3: d.sectors?.[2]?.value ? { time: d.sectors[2].value, color: d.sectors[2].status } : null,
    }))
    return {
      source:      'snapshot',
      sessionName: snapshot.sessionName,
      raceName:    snapshot.raceName,
      isRaceType:  snapshot.isRaceType,
      completed:   true,
      savedAt:     snapshot.savedAt,
      updatedAt:   new Date().toISOString(),
      drivers,
    }
  }

  // Last fallback: OpenF1 polling (cached — null result held for 5min, active for 30s)
  const session = await findLiveSession()
  if (!session) return null
  const drivers = await getLiveTimingTower(session.sessionKey, session.isRaceType)
  if (!drivers) return null
  return {
    source:      'openf1',
    sessionKey:  session.sessionKey,
    sessionName: session.sessionName,
    raceName:    session.raceName,
    isRaceType:  session.isRaceType,
    updatedAt:   new Date().toISOString(),
    drivers,
  }
}

// ── Team pace ─────────────────────────────────────────────────────────────────

async function findTeamRaceAndDrivers(metaRows, teamName, requestedRaceId) {
  const sorted   = [...metaRows].sort((a, b) =>
    parseInt(b.race_id.split('_')[1] || 0) - parseInt(a.race_id.split('_')[1] || 0))
  const keywords = teamName.toLowerCase().split(' ').filter(w => w.length > 3)

  let teamDrivers = [], foundRaceId = null, foundRaceName = null
  const availableRaces = []

  for (const meta of sorted) {
    const rows    = await repo.queryRaceDrivers(meta.race_id)
    const matched = rows.filter(d => keywords.some(kw => d.team_name?.toLowerCase().includes(kw)))
    if (matched.length >= 1) {
      availableRaces.push({ raceId: meta.race_id, raceName: meta.race_name })
      if (!foundRaceId && (!requestedRaceId || meta.race_id === requestedRaceId)) {
        teamDrivers = matched; foundRaceId = meta.race_id; foundRaceName = meta.race_name
      }
    }
  }
  return { teamDrivers, foundRaceId, foundRaceName, availableRaces }
}

async function computeFieldStats(foundRaceId, allDriverRows) {
  const fieldLapMap = new Map()
  const fieldS      = { s1: 0, s2: 0, s3: 0, n: 0 }

  await Promise.all(allDriverRows.map(async d => {
    const rows = await repo.queryLapTimes(foundRaceId, d.driver_id)
    for (const r of rows) {
      if (!r.lap_time || r.lap_time <= 0) continue
      if (!fieldLapMap.has(r.lap_number)) fieldLapMap.set(r.lap_number, [])
      fieldLapMap.get(r.lap_number).push(r.lap_time)
      if (r.sector1 && r.sector2 && r.sector3) {
        fieldS.s1 += r.sector1; fieldS.s2 += r.sector2; fieldS.s3 += r.sector3; fieldS.n++
      }
    }
  }))

  const fieldAvgPerLap = [...fieldLapMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lap, times]) => {
      const s = [...times].sort((a, b) => a - b)
      return { lap, avg: Math.round(s[Math.floor(s.length / 2)] * 1000) / 1000 }
    })

  const allTimes = fieldAvgPerLap.map(f => f.avg).sort((a, b) => a - b)
  const p25      = allTimes[Math.floor(allTimes.length * 0.25)]
  const p75      = allTimes[Math.floor(allTimes.length * 0.75)]
  const iqr      = p75 - p25
  const clean    = allTimes.filter(t => t >= p25 - 1.5 * iqr && t <= p75 + 1.5 * iqr)
  const fieldAvgLap = clean.length
    ? Math.round(clean.reduce((a, b) => a + b, 0) / clean.length * 1000) / 1000
    : null

  return { fieldAvgPerLap, fieldAvgLap, fieldS }
}

async function computeTeamDriverPace(foundRaceId, teamDrivers) {
  return Promise.all(teamDrivers.map(async d => {
    const [laps, stints] = await Promise.all([
      repo.queryLapTimes(foundRaceId, d.driver_id),
      repo.queryStints(foundRaceId, d.driver_id),
    ])
    return {
      driverId: d.driver_id, acronym: d.acronym, fullName: d.full_name,
      laps: laps
        .filter(l => l.lap_time > 0)
        .map(l => {
          const stint = stints.find(s => l.lap_number >= s.lap_start && l.lap_number <= s.lap_end)
          return {
            lap: l.lap_number, time: Math.round(l.lap_time * 1000) / 1000,
            s1: l.sector1, s2: l.sector2, s3: l.sector3, compound: stint?.compound || null,
          }
        }),
    }
  }))
}

function computeSectorDominance(driverPace, fieldS) {
  const teamS = { s1: 0, s2: 0, s3: 0, n: 0 }
  for (const d of driverPace)
    for (const l of d.laps)
      if (l.s1 && l.s2 && l.s3) { teamS.s1 += l.s1; teamS.s2 += l.s2; teamS.s3 += l.s3; teamS.n++ }

  if (!teamS.n || !fieldS.n) return null
  const tAvg = [teamS.s1 / teamS.n, teamS.s2 / teamS.n, teamS.s3 / teamS.n]
  const fAvg = [fieldS.s1 / fieldS.n, fieldS.s2 / fieldS.n, fieldS.s3 / fieldS.n]
  return [1, 2, 3].map((s, i) => ({
    sector:   `S${s}`,
    teamAvg:  Math.round(tAvg[i] * 1000) / 1000,
    fieldAvg: Math.round(fAvg[i] * 1000) / 1000,
    delta:    Math.round((tAvg[i] - fAvg[i]) * 1000) / 1000,
  }))
}

export async function getTeamPace(teamName, year, requestedRaceId) {
  const metaRows = await repo.queryRaceMetaByYear(year)
  if (!metaRows.length) return null

  const { teamDrivers, foundRaceId, foundRaceName, availableRaces } =
    await findTeamRaceAndDrivers(metaRows, teamName, requestedRaceId)
  if (!teamDrivers.length) return null

  const allDriverRows = await repo.queryRaceDrivers(foundRaceId)
  const { fieldAvgPerLap, fieldAvgLap, fieldS } = await computeFieldStats(foundRaceId, allDriverRows)
  const driverPace    = await computeTeamDriverPace(foundRaceId, teamDrivers)
  const sectorDominance = computeSectorDominance(driverPace, fieldS)

  return {
    raceId: foundRaceId, raceName: foundRaceName,
    availableRaces: availableRaces.reverse(),
    drivers: driverPace, fieldAvgLap, fieldAvgPerLap, sectorDominance,
  }
}
