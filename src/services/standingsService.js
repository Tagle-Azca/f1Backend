import * as raceRepository   from '../repositories/raceRepository.js'
import * as driverRepository from '../repositories/driverRepository.js'
import { buildDriverName, roundPoints, normalizeRaceName } from '../utils/formatters.js'

/** Converts a per-round points array into a cumulative running-total array. */
function buildCumulativePoints(earnedPoints) {
  const cumulative = []
  let total = 0
  for (const pts of earnedPoints) {
    total += pts
    cumulative.push(roundPoints(total))
  }
  return cumulative
}

/**
 * Returns cumulative driver championship standings for a season.
 * @param {string} season
 * @returns {{ rounds: object[], drivers: object[] }}
 */
export async function getSeasonStandings(season) {
  const races = await raceRepository.findBySeasonForStandings(season)

  if (!races.length) return { rounds: [], drivers: [] }

  races.sort((a, b) => Number(a.round) - Number(b.round))

  const rounds = races.map(r => ({
    round:    r.round,
    raceName: normalizeRaceName(r.raceName),
    date:     r.date,
  }))

  const driverInfo   = new Map() // driverId → { driverId, name, team, teamId }
  const pointsMatrix = new Map() // driverId → Array<number>

  races.forEach((race, idx) => {
    for (const result of [...(race.Results || []), ...(race.SprintResults || [])]) {
      if (!result.Driver?.driverId) continue
      const dId = result.Driver.driverId
      const pts = parseFloat(result.points) || 0

      if (!driverInfo.has(dId)) {
        driverInfo.set(dId, {
          driverId: dId,
          name:     buildDriverName(result.Driver),
          team:     result.Constructor?.name           || '',
          teamId:   result.Constructor?.constructorId || '',
        })
        pointsMatrix.set(dId, new Array(races.length).fill(0))
      }
      if (result.Constructor?.name) {
        driverInfo.get(dId).team   = result.Constructor.name
        driverInfo.get(dId).teamId = result.Constructor.constructorId
      }
      pointsMatrix.get(dId)[idx] += pts
    }
  })

  const driverIds  = [...driverInfo.keys()]
  const driverDocs = await driverRepository.findByIds(driverIds)
  const numberMap  = new Map(driverDocs.map(d => [d.driverId, d.permanentNumber || d.code || null]))

  const drivers = []
  for (const [dId, info] of driverInfo) {
    const cumulative  = buildCumulativePoints(pointsMatrix.get(dId))
    const finalPoints = cumulative[cumulative.length - 1] ?? 0
    drivers.push({ ...info, number: numberMap.get(dId) || null, finalPoints, cumulative })
  }

  drivers.sort((a, b) => b.finalPoints - a.finalPoints)

  return { rounds, drivers }
}

/**
 * Returns cumulative constructor championship standings for a season.
 * @param {string} season
 * @returns {{ rounds: object[], constructors: object[] }}
 */
export async function getConstructorStandings(season) {
  const races = await raceRepository.findBySeasonForStandings(season)

  if (!races.length) return { rounds: [], constructors: [] }

  races.sort((a, b) => Number(a.round) - Number(b.round))

  const rounds = races.map(r => ({
    round:    r.round,
    raceName: normalizeRaceName(r.raceName),
    date:     r.date,
  }))

  const ctorInfo     = new Map() // constructorId → { constructorId, name }
  const pointsMatrix = new Map() // constructorId → Array<number>

  races.forEach((race, idx) => {
    for (const result of [...(race.Results || []), ...(race.SprintResults || [])]) {
      if (!result.Constructor?.constructorId) continue
      const cId = result.Constructor.constructorId
      const pts = parseFloat(result.points) || 0

      if (!ctorInfo.has(cId)) {
        ctorInfo.set(cId, { constructorId: cId, name: result.Constructor.name })
        pointsMatrix.set(cId, new Array(races.length).fill(0))
      }
      pointsMatrix.get(cId)[idx] += pts
    }
  })

  const constructors = []
  for (const [cId, info] of ctorInfo) {
    const cumulative  = buildCumulativePoints(pointsMatrix.get(cId))
    const finalPoints = cumulative[cumulative.length - 1] ?? 0
    constructors.push({ ...info, finalPoints, cumulative })
  }

  constructors.sort((a, b) => b.finalPoints - a.finalPoints)

  return { rounds, constructors }
}

/**
 * Returns all drivers who appeared in race results for a season.
 * @param {string} season
 * @returns {Array<{ driverId: string, name: string, team: string, teamId: string }>}
 */
export async function getSeasonDrivers(season) {
  const races = await raceRepository.findBySeasonSorted(season, 'Results')
  const map = {}
  for (const race of races) {
    for (const r of race.Results || []) {
      const d = r.Driver
      if (d?.driverId && !map[d.driverId]) {
        map[d.driverId] = buildDriverName(d)
      }
    }
  }
  return Object.entries(map)
    .map(([driverId, name]) => ({ driverId, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
