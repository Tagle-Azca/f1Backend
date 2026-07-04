import * as raceRepository   from '../repositories/raceRepository.js'
import * as driverRepository from '../repositories/driverRepository.js'
import * as jolpica          from '../repositories/jolpicaRepository.js'
import { cached } from '../utils/cache.js'
import { buildDriverName, roundPoints, normalizeRaceName } from '../utils/formatters.js'

const OFFICIAL_STANDINGS_TTL = 10 * 60_000

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
 * Official standings from Jolpica — the source of truth for final points,
 * positions and tie-breaks (covers penalties and wins countback that a plain
 * sum of race points cannot). Returns [] on failure so callers fall back to
 * the Mongo-computed totals.
 */
async function fetchOfficialDriverStandings(season) {
  try {
    return await cached(`standings:official:drivers:${season}`, OFFICIAL_STANDINGS_TTL,
      () => jolpica.fetchDriverStandings(season))
  } catch {
    return []
  }
}

async function fetchOfficialConstructorStandings(season) {
  try {
    return await cached(`standings:official:constructors:${season}`, OFFICIAL_STANDINGS_TTL,
      () => jolpica.fetchConstructorStandings(season))
  } catch {
    return []
  }
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

  const driverInfo   = new Map() // driverId → { driverId, name, team, teamId, wins }
  const pointsMatrix = new Map() // driverId → Array<number>

  races.forEach((race, idx) => {
    const raceResults   = (race.Results || []).map(r => ({ ...r, isSprint: false }))
    const sprintResults = (race.SprintResults || []).map(r => ({ ...r, isSprint: true }))

    for (const result of [...raceResults, ...sprintResults]) {
      if (!result.Driver?.driverId) continue
      const dId = result.Driver.driverId
      const pts = parseFloat(result.points) || 0

      if (!driverInfo.has(dId)) {
        driverInfo.set(dId, {
          driverId: dId,
          name:     buildDriverName(result.Driver),
          team:     result.Constructor?.name           || '',
          teamId:   result.Constructor?.constructorId || '',
          wins:     0,
        })
        pointsMatrix.set(dId, new Array(races.length).fill(0))
      }
      if (result.Constructor?.name) {
        driverInfo.get(dId).team   = result.Constructor.name
        driverInfo.get(dId).teamId = result.Constructor.constructorId
      }
      if (!result.isSprint && parseInt(result.position) === 1) driverInfo.get(dId).wins++
      pointsMatrix.get(dId)[idx] += pts
    }
  })

  const [driverDocs, officialStandings] = await Promise.all([
    driverRepository.findByIds([...driverInfo.keys()]),
    fetchOfficialDriverStandings(season),
  ])
  const numberMap  = new Map(driverDocs.map(d => [d.driverId, d.permanentNumber || d.code || null]))
  const officialByDriver = new Map(officialStandings.map(s => [s.Driver?.driverId, s]))

  const drivers = []
  for (const [dId, info] of driverInfo) {
    const cumulative = buildCumulativePoints(pointsMatrix.get(dId))
    const official   = officialByDriver.get(dId)

    // Ergast lists every constructor the driver raced for; the last is current
    const currentCtor = official?.Constructors?.[official.Constructors.length - 1]
    if (currentCtor) {
      info.team   = currentCtor.name
      info.teamId = currentCtor.constructorId
    }

    drivers.push({
      ...info,
      number:           numberMap.get(dId) || null,
      wins:             official ? parseInt(official.wins) || 0 : info.wins,
      finalPoints:      official ? roundPoints(parseFloat(official.points) || 0) : cumulative[cumulative.length - 1] ?? 0,
      officialPosition: official ? parseInt(official.position) || null : null,
      cumulative,
    })
  }

  drivers.sort((a, b) =>
    (a.officialPosition ?? Infinity) - (b.officialPosition ?? Infinity)
    || b.finalPoints - a.finalPoints
    || b.wins - a.wins
  )

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

  const ctorInfo     = new Map() // constructorId → { constructorId, name, wins }
  const pointsMatrix = new Map() // constructorId → Array<number>

  races.forEach((race, idx) => {
    const raceResults   = (race.Results || []).map(r => ({ ...r, isSprint: false }))
    const sprintResults = (race.SprintResults || []).map(r => ({ ...r, isSprint: true }))

    for (const result of [...raceResults, ...sprintResults]) {
      if (!result.Constructor?.constructorId) continue
      const cId = result.Constructor.constructorId
      const pts = parseFloat(result.points) || 0

      if (!ctorInfo.has(cId)) {
        ctorInfo.set(cId, { constructorId: cId, name: result.Constructor.name, wins: 0 })
        pointsMatrix.set(cId, new Array(races.length).fill(0))
      }
      if (!result.isSprint && parseInt(result.position) === 1) ctorInfo.get(cId).wins++
      pointsMatrix.get(cId)[idx] += pts
    }
  })

  const officialStandings = await fetchOfficialConstructorStandings(season)
  const officialByCtor    = new Map(officialStandings.map(s => [s.Constructor?.constructorId, s]))

  const constructors = []
  for (const [cId, info] of ctorInfo) {
    const cumulative = buildCumulativePoints(pointsMatrix.get(cId))
    const official   = officialByCtor.get(cId)

    constructors.push({
      ...info,
      wins:             official ? parseInt(official.wins) || 0 : info.wins,
      finalPoints:      official ? roundPoints(parseFloat(official.points) || 0) : cumulative[cumulative.length - 1] ?? 0,
      officialPosition: official ? parseInt(official.position) || null : null,
      cumulative,
    })
  }

  constructors.sort((a, b) =>
    (a.officialPosition ?? Infinity) - (b.officialPosition ?? Infinity)
    || b.finalPoints - a.finalPoints
    || b.wins - a.wins
  )

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
