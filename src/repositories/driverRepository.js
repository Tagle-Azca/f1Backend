import Driver from '../models/Driver.js'
import Race   from '../models/Race.js'

/**
 * Paginated list of drivers with optional filters.
 * Accepts either a raw `skip` offset or a `page` number (1-based).
 * If both are provided, `skip` takes precedence.
 * @param {{ search?: string, nationality?: string, skip?: number, page?: number, limit?: number }} opts
 */
export function findAll({ search, nationality, skip: rawSkip, page = 1, limit = 100 } = {}) {
  const filter = {}
  if (nationality) filter.nationality = nationality
  if (search) {
    filter.$or = [
      { givenName:  { $regex: search, $options: 'i' } },
      { familyName: { $regex: search, $options: 'i' } },
    ]
  }
  const skip = rawSkip != null ? rawSkip : (page - 1) * limit
  return Driver.find(filter)
    .sort({ familyName: 1 })
    .skip(skip)
    .limit(limit)
    .lean()
}

/** Single driver by driverId. */
export function findById(driverId) {
  return Driver.findOne({ driverId }).lean()
}

/**
 * Drivers who raced in seasons >= fromSeason.
 * Uses Race.distinct to get driverIds, then fetches Driver documents.
 */
export async function findRecentlyActive(fromSeason) {
  const driverIds = await Race.distinct('Results.Driver.driverId', {
    season: { $gte: String(fromSeason) },
  })
  return Driver.find({ driverId: { $in: driverIds } })
    .select('driverId givenName familyName nationality permanentNumber photoUrl code')
    .sort({ familyName: 1 })
    .lean()
}

/** All driverIds who appeared in race Results for a given season. */
export function findBySeasonResults(season) {
  return Race.distinct('Results.Driver.driverId', { season })
}

/**
 * Fetch multiple Driver documents by an array of driverIds.
 * Selects only the fields needed for standings number lookups.
 * @param {string[]} driverIds
 */
export function findByIds(driverIds) {
  return Driver.find({ driverId: { $in: driverIds } })
    .select('driverId permanentNumber code')
    .lean()
}

/**
 * Search drivers by name regex.
 * @param {RegExp} regex
 * @param {number} limit
 */
export function searchByName(regex, limit) {
  return Driver.find({ $or: [{ givenName: regex }, { familyName: regex }] })
    .select('driverId givenName familyName nationality permanentNumber')
    .limit(limit)
    .lean()
}

/**
 * Returns drivers who participated in a specific season, enriched with their
 * last known constructor for that season.
 * @param {string} season
 * @returns {Promise<Array<{ driverId, givenName, familyName, nationality, permanentNumber, photoUrl, code, constructorId, constructorName }>>}
 */
export async function findBySeasonWithConstructors(season) {
  const races = await Race.find({ season })
    .select('Results.Driver.driverId Results.Constructor')
    .lean()

  const ctorMap = {}
  for (const race of races) {
    for (const r of race.Results || []) {
      if (r.Driver?.driverId && r.Constructor?.constructorId) {
        ctorMap[r.Driver.driverId] = {
          constructorId:   r.Constructor.constructorId,
          constructorName: r.Constructor.name,
        }
      }
    }
  }

  const driverIds = Object.keys(ctorMap)
  const drivers   = await Driver.find({ driverId: { $in: driverIds } })
    .select('driverId givenName familyName nationality permanentNumber photoUrl code')
    .lean()

  return drivers
    .map(d => ({ ...d, ...(ctorMap[d.driverId] || {}) }))
    .sort((a, b) => a.familyName.localeCompare(b.familyName))
}
