import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
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

export async function getSeasonStandings(req, res, next) {
  try {
    const { season } = req.params

    const races = await Race.find({ season })
      .select('round raceName date Results SprintResults')
      .sort({ round: 1 })
      .lean()

    if (!races.length) return res.json({ rounds: [], drivers: [] })

    races.sort((a, b) => Number(a.round) - Number(b.round))

    const rounds = races.map(r => ({
      round:    r.round,
      raceName: normalizeRaceName(r.raceName),
      date:     r.date,
    }))

    const driverInfo   = new Map() // driverId → { name, team, teamId }
    const pointsMatrix = new Map() // driverId → Array

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
    const driverDocs = await Driver.find({ driverId: { $in: driverIds } })
      .select('driverId permanentNumber code').lean()
    const numberMap  = new Map(driverDocs.map(d => [d.driverId, d.permanentNumber || d.code || null]))

    const drivers = []
    for (const [dId, info] of driverInfo) {
      const cumulative = buildCumulativePoints(pointsMatrix.get(dId))
      const finalPoints = cumulative[cumulative.length - 1] ?? 0
      drivers.push({ ...info, number: numberMap.get(dId) || null, finalPoints, cumulative })
    }

    drivers.sort((a, b) => b.finalPoints - a.finalPoints)

    res.json({ rounds, drivers })
  } catch (err) { next(err) }
}

export async function getConstructorStandings(req, res, next) {
  try {
    const { season } = req.params

    const races = await Race.find({ season })
      .select('round raceName date Results SprintResults')
      .sort({ round: 1 })
      .lean()

    if (!races.length) return res.json({ rounds: [], constructors: [] })

    races.sort((a, b) => Number(a.round) - Number(b.round))

    const rounds = races.map(r => ({
      round:    r.round,
      raceName: normalizeRaceName(r.raceName),
      date:     r.date,
    }))

    const ctorInfo     = new Map() // constructorId → { name, constructorId }
    const pointsMatrix = new Map()

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

    res.json({ rounds, constructors })
  } catch (err) { next(err) }
}

export async function getSeasonDrivers(req, res, next) {
  try {
    const { season } = req.params
    const races = await Race.find({ season }).select('Results').lean()
    const map = {}
    for (const race of races) {
      for (const r of race.Results || []) {
        const d = r.Driver
        if (d?.driverId && !map[d.driverId]) {
          map[d.driverId] = buildDriverName(d)
        }
      }
    }
    const list = Object.entries(map)
      .map(([driverId, name]) => ({ driverId, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json(list)
  } catch (err) { next(err) }
}
