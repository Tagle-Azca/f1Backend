import { roundPoints, normalizeRaceName } from '../utils/formatters.js'
import * as driverRepo from '../repositories/driverRepository.js'
import {
  queryRaceIdsByDriverId,
  queryAllLapTimesByRace,
} from '../repositories/telemetryRepository.js'

async function countCassandraFastestLaps(permanentNumber) {
  if (!permanentNumber) return 0
  try {
    const driverRaces = await queryRaceIdsByDriverId(permanentNumber)
    if (!driverRaces.length) return 0

    let count = 0
    for (const { race_id } of driverRaces) {
      const allLaps = await queryAllLapTimesByRace(race_id)
      const valid   = allLaps.filter(l => l.lap_time > 60)
      if (!valid.length) continue

      let minTime = Infinity, minDriver = null
      for (const l of valid) {
        if (l.lap_time < minTime) { minTime = l.lap_time; minDriver = l.driver_id }
      }
      if (minDriver === permanentNumber) count++
    }
    return count
  } catch {
    return 0
  }
}

export async function getDriverStatsData(id) {
  const [driver, agg] = await Promise.all([
    driverRepo.findById(id),
    driverRepo.aggregateCareerStats(id),
  ])

  if (!driver) return null

  const s                   = agg[0] || {}
  const cassandraFastestLaps = await countCassandraFastestLaps(driver.permanentNumber)
  const seasons              = (s.seasons || []).sort()
  const races                = s.races || 0
  const top10s               = s.top10s || 0
  const dnfs                 = s.dnfs   || 0
  const classifiedRaces      = s.classifiedRaces      || 0
  const totalPositionsGained = s.totalPositionsGained  || 0

  return {
    driver,
    wins:          s.wins         || 0,
    podiums:       s.podiums      || 0,
    races,
    points:        s.points ? (Number.isInteger(s.points) ? s.points : parseFloat(s.points.toFixed(2))) : 0,
    polePositions: s.polePositions || 0,
    fastestLaps:   (s.fastestLaps || 0) + cassandraFastestLaps,
    teams:         (s.teams || []).filter(Boolean),
    firstSeason:   seasons[0]                 || null,
    lastSeason:    seasons[seasons.length - 1] || null,
    totalSeasons:  seasons.length,
    top10s,
    dnfs,
    pointsPerRace:      races > 0 ? parseFloat(((s.points || 0) / races).toFixed(2))  : 0,
    top10Rate:          races > 0 ? parseFloat(((top10s    / races) * 100).toFixed(1)) : 0,
    dnfRate:            races > 0 ? parseFloat(((dnfs      / races) * 100).toFixed(1)) : 0,
    avgPositionsGained: classifiedRaces > 0
      ? parseFloat((totalPositionsGained / classifiedRaces).toFixed(2))
      : 0,
  }
}

export function getDriverCircuitsData(id) {
  return driverRepo.aggregateCircuitResults(id)
}

export async function getDriverSeasonsData(id) {
  const results = await driverRepo.aggregateSeasonResults(id)
  return results.map(r => ({
    season:        r._id,
    team:          r.team,
    constructorId: r.constructorId,
    points:        roundPoints(r.points),
    wins:          r.wins,
    podiums:       r.podiums,
    poles:         r.poles,
    races:         r.races,
  }))
}

export async function getDriverNetworkData(id) {
  const [activeDriver, teammateAgg] = await Promise.all([
    driverRepo.findById(id),
    driverRepo.aggregateTeammates(id),
  ])

  if (!activeDriver) return null

  const teammateIds = [...new Set(teammateAgg.map(e => e._id.teammateId))]
  const driverDocs  = await driverRepo.findTeammateMetadata(teammateIds)
  const driverMeta  = Object.fromEntries(driverDocs.map(d => [d.driverId, d]))

  const nodeMap = new Map()

  nodeMap.set(id, {
    id,
    label:         activeDriver.code || id.substring(0, 3).toUpperCase(),
    fullName:      `${activeDriver.givenName} ${activeDriver.familyName}`,
    type:          'activeDriver',
    photoUrl:      activeDriver.photoUrl || null,
    constructorId: teammateAgg[0]?.activeConstructorId || null,
  })

  for (const edge of teammateAgg) {
    const tmId = edge._id.teammateId
    if (nodeMap.has(tmId)) continue
    const meta = driverMeta[tmId] || {}
    nodeMap.set(tmId, {
      id:            tmId,
      label:         meta.code || tmId.substring(0, 3).toUpperCase(),
      fullName:      `${edge.givenName} ${edge.familyName}`.trim(),
      type:          'driver',
      photoUrl:      meta.photoUrl || null,
      constructorId: edge._id.constructorId,
    })
  }

  const edges = teammateAgg.map(edge => ({
    source:        id,
    target:        edge._id.teammateId,
    seasons:       edge.seasons.sort(),
    constructorId: edge._id.constructorId,
    teamName:      edge.teamName,
  }))

  return { nodes: [...nodeMap.values()], edges }
}

export async function getHistoricalPerformanceData(driverId, year) {
  const [driverRaces, allRaces] = await Promise.all([
    driverRepo.aggregateRaceResults(driverId, year),
    driverRepo.aggregateFieldResults(year),
  ])

  if (!driverRaces.length) return { races: [], stats: null, reliability: {} }

  const seasonMaxPoints = allRaces.reduce((sum, race) => {
    const best = Math.max(0, ...(race.Results || []).map(r => parseFloat(r.points) || 0))
    return sum + best
  }, 0)

  const raceResults = []
  const reliability = {}
  let wins = 0, podiums = 0, poles = 0, fastestLaps = 0, points = 0, finishes = 0

  for (const race of driverRaces.sort((a, b) => Number(a.round) - Number(b.round))) {
    const result = race.Results?.find(r => r.Driver?.driverId === driverId)
    if (!result) continue

    const pos    = parseInt(result.position)
    const grid   = parseInt(result.grid)
    const status = result.status || 'Unknown'
    const pts    = parseFloat(result.points) || 0
    const fin    = status === 'Finished' || /^\+\d+ Lap/.test(status)

    raceResults.push({
      round:    Number(race.round),
      raceName: normalizeRaceName(race.raceName),
      grid:     isNaN(grid) ? null : grid,
      position: isNaN(pos)  ? null : pos,
      status, points: pts, finished: fin,
    })

    reliability[status] = (reliability[status] || 0) + 1
    if (!isNaN(pos) && pos === 1) wins++
    if (!isNaN(pos) && pos <= 3)  podiums++
    if (!isNaN(grid) && grid === 1) poles++
    if (result.FastestLap?.rank === '1') fastestLaps++
    points += pts
    if (fin) finishes++
  }

  const total = raceResults.length
  return {
    races: raceResults,
    stats: {
      wins, podiums, poles, fastestLaps,
      points:      roundPoints(points),
      maxPoints:   roundPoints(seasonMaxPoints),
      races:       total,
      finishes,
      dnfs:        total - finishes,
      reliability: total ? Math.round((finishes / total) * 100) : 0,
    },
    reliability,
  }
}
