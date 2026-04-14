import logger from '../utils/logger.js'
import * as repo from '../repositories/openf1Repository.js'

// ── Per-driver live data ──────────────────────────────────────────────────────

export async function getLiveDrivers(sessionKey) {
  const drivers = await repo.fetchDrivers(sessionKey)
  return drivers.map(d => ({
    driverId: String(d.driver_number),
    acronym:  d.name_acronym || '',
    fullName: d.full_name    || '',
    teamName: d.team_name    || '',
  }))
}

export async function getLiveLapTimes(sessionKey, driverId) {
  const [laps, allStints] = await Promise.all([
    repo.fetchLaps(sessionKey, driverId),
    repo.fetchStints(sessionKey),
  ])

  const driverStints = allStints.filter(s => String(s.driver_number) === String(driverId))

  return laps
    .filter(l => l.lap_duration != null && l.lap_duration > 0 && parseFloat(l.lap_duration) <= 300)
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
  const pits = await repo.fetchPits(sessionKey, driverId)
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
      repo.fetchLaps(sessionKey, driverId),
      repo.fetchPits(sessionKey, driverId),
    ])
    const pitLapSet = new Set(
      pits.filter(p => p.pit_duration && p.pit_duration >= 2).map(p => p.lap_number)
    )
    return {
      driverId,
      laps: laps
        .filter(l => l.lap_duration != null && l.lap_duration > 0 && parseFloat(l.lap_duration) <= 300)
        .map(l => ({ lap: l.lap_number, time: parseFloat(l.lap_duration), isPit: pitLapSet.has(l.lap_number) })),
    }
  }))
}

export async function getLiveTireStrategy(sessionKey) {
  const [stints, drivers] = await Promise.all([
    repo.fetchStints(sessionKey),
    repo.fetchDrivers(sessionKey),
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

// ── Safety car periods ────────────────────────────────────────────────────────

function parseSafetyCarPeriods(events) {
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.date || 0).getTime()
    const tb = new Date(b.date || 0).getTime()
    if (ta !== tb) return ta - tb
    return (a.lap_number ?? 0) - (b.lap_number ?? 0)
  })

  const relevant = sorted.filter(e => {
    const t = `${e.category} ${e.flag} ${e.message}`.toUpperCase()
    return t.includes('SAFETY') || t.includes('VSC') || t.includes('VIRTUAL')
  })
  if (relevant.length) {
    logger.debug(
      { events: relevant.map(e => `lap=${e.lap_number ?? 'null'} cat=${e.category} flag=${e.flag} msg=${e.message}`) },
      '[SC] events'
    )
  }

  const periods    = []
  let openSC       = null  // { type: 'SC',  lapStart }
  let openVSC      = null  // { type: 'VSC', lapStart }
  let lastKnownLap = 1

  for (const e of sorted) {
    const lap = e.lap_number != null ? e.lap_number : lastKnownLap
    if (e.lap_number != null) lastKnownLap = e.lap_number

    const flag = (e.flag     || '').toUpperCase().trim()
    const msg  = (e.message  || '').toUpperCase().trim()
    const cat  = (e.category || '').toLowerCase().trim()
    const text = `${flag} ${msg}`

    // OpenF1 sometimes sends cat=SafetyCar + msg='VSC DEPLOYED' instead of cat=vsc
    const isVSC = cat === 'vsc' || msg.includes('VSC') || (text.includes('VIRTUAL') && text.includes('SAFETY'))

    if (isVSC) {
      if (text.includes('DEPLOY')) {
        if (openVSC) periods.push({ ...openVSC, lapEnd: lap })
        openVSC = { type: 'VSC', lapStart: lap }
      } else if (text.includes('END') || text.includes('IN THIS') || text.includes('CLEAR')) {
        if (openVSC) { periods.push({ ...openVSC, lapEnd: lap + 1 }); openVSC = null }
      }
    } else if (cat === 'safetycar' || (text.includes('SAFETY CAR') && !text.includes('VIRTUAL') && !msg.includes('VSC'))) {
      if (text.includes('DEPLOY')) {
        if (openSC) periods.push({ ...openSC, lapEnd: lap })
        openSC = { type: 'SC', lapStart: lap }
      } else if (text.includes('IN THIS') || text.includes('WITHDRAWN') || text.includes('CLEAR') || text.includes('END')) {
        if (openSC) { periods.push({ ...openSC, lapEnd: lap + 1 }); openSC = null }
      }
    }
  }

  // Cap unclosed periods — SC rarely runs >8 laps, VSC >5
  if (openSC)  periods.push({ ...openSC,  lapEnd: openSC.lapStart  + 8 })
  if (openVSC) periods.push({ ...openVSC, lapEnd: openVSC.lapStart + 5 })

  return periods.filter(p => p.lapEnd > p.lapStart).sort((a, b) => a.lapStart - b.lapStart)
}

export async function getSafetyCarPeriods(sessionKey) {
  const events = await repo.fetchRaceControl(sessionKey)
  if (!Array.isArray(events) || !events.length) return []
  return parseSafetyCarPeriods(events)
}

// ── Race positions chart ──────────────────────────────────────────────────────

function buildPitsByDriver(allPits) {
  const pitsByDriver = new Map()
  for (const p of allPits) {
    if (!p.pit_duration || p.pit_duration < 2) continue
    const k = String(p.driver_number)
    if (!pitsByDriver.has(k)) pitsByDriver.set(k, new Set())
    pitsByDriver.get(k).add(p.lap_number)
  }
  return pitsByDriver
}

function buildLapEndTimes(allLaps) {
  const lapEndTimes = new Map()
  for (const l of allLaps) {
    if (!l.lap_number || !l.lap_duration || !l.date_start) continue
    const lapEndMs = new Date(l.date_start).getTime() + parseFloat(l.lap_duration) * 1000
    if (!lapEndTimes.has(l.lap_number)) lapEndTimes.set(l.lap_number, lapEndMs)
  }
  return lapEndTimes
}

// Matches position events to lap boundaries by timestamp — same logic as the seeder
function buildDriverLapPositions(posByDriver, lapEndTimes) {
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
    if (!lapMap.has(1) && lapMap.size > 0) {
      const firstLap = Math.min(...lapMap.keys())
      lapMap.set(1, lapMap.get(firstLap))
    }
    driverLapPos.set(num, lapMap)
  }
  return driverLapPos
}

function buildPositionsChart(driverLapPos, maxLap) {
  const activeNums = [...driverLapPos.keys()]
  return Array.from({ length: maxLap }, (_, i) => {
    const lap = i + 1
    const row = { lap }
    for (const num of activeNums) {
      const pos = driverLapPos.get(num)?.get(lap)
      if (pos != null) row[String(num)] = pos
    }
    return row
  })
}

function buildDriverList(posByDriver, driverLapPos, pitsByDriver, driverMap, maxLap) {
  return [...posByDriver.keys()].map(num => {
    const dId    = String(num)
    const d      = driverMap.get(num)
    const lapMap = driverLapPos.get(num)
    const lastLap = lapMap?.size ? Math.max(...lapMap.keys()) : null
    const dns    = !lapMap || lapMap.size === 0
    const dnf    = !dns && lastLap !== null && lastLap < maxLap - 1
    return {
      driverId: dId,
      acronym:  d?.name_acronym || dId,
      teamName: d?.team_name    || '',
      pitLaps:  [...(pitsByDriver.get(dId) || [])],
      dns, dnf, lastLap,
    }
  })
}

export async function getLivePositions(sessionKey) {
  const [allPos, allLaps, allPits, drivers] = await Promise.all([
    repo.fetchPositions(sessionKey),
    repo.fetchLaps(sessionKey),
    repo.fetchPits(sessionKey),
    repo.fetchDrivers(sessionKey),
  ])

  const driverMap    = new Map(drivers.map(d => [d.driver_number, d]))
  const pitsByDriver = buildPitsByDriver(allPits)
  const lapEndTimes  = buildLapEndTimes(allLaps)

  // Position history per driver must be sorted by timestamp for the lap-end lookup
  const posByDriver = new Map()
  for (const p of allPos) {
    const k = p.driver_number
    if (!posByDriver.has(k)) posByDriver.set(k, [])
    posByDriver.get(k).push({ t: new Date(p.date).getTime(), pos: p.position })
  }
  for (const arr of posByDriver.values()) arr.sort((a, b) => a.t - b.t)

  const maxLap         = lapEndTimes.size ? Math.max(...lapEndTimes.keys()) : 0
  const driverLapPos   = buildDriverLapPositions(posByDriver, lapEndTimes)
  const positionsByLap = buildPositionsChart(driverLapPos, maxLap)
  const result         = buildDriverList(posByDriver, driverLapPos, pitsByDriver, driverMap, maxLap)

  return { drivers: result, laps: positionsByLap, totalLaps: maxLap }
}

export { getOpenF1RaceSessions } from '../repositories/openf1Repository.js'
