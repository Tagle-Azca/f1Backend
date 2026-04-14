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

/** Minimal driver meta (photo, number, code) for display enrichment. */
export function findDriverMeta(driverId) {
  return Driver.findOne({ driverId }).select('photoUrl permanentNumber code').lean()
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

// ── Driver stats aggregations ─────────────────────────────────────────────────

export function aggregateCareerStats(driverId) {
  return Race.aggregate([
    { $match: { 'Results.Driver.driverId': driverId } },
    { $unwind: '$Results' },
    { $match: { 'Results.Driver.driverId': driverId } },
    { $group: {
      _id:     null,
      wins:    { $sum: { $cond: [{ $eq: ['$Results.position', '1'] }, 1, 0] } },
      podiums: { $sum: { $cond: [{ $and: [
        { $ne:  ['$Results.position', '\\N'] },
        { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 3] },
      ]}, 1, 0] } },
      races:         { $sum: 1 },
      points:        { $sum: { $toDouble: { $ifNull: ['$Results.points', '0'] } } },
      seasons:       { $addToSet: '$season' },
      teams:         { $addToSet: '$Results.Constructor.name' },
      polePositions: { $sum: { $cond: [{ $eq: ['$Results.grid', '1'] }, 1, 0] } },
      fastestLaps:   { $sum: { $cond: [{ $eq: ['$Results.FastestLap.rank', '1'] }, 1, 0] } },
      top10s: { $sum: { $cond: [{ $and: [
        { $ne:  ['$Results.position', '\\N'] },
        { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 10] },
      ]}, 1, 0] } },
      dnfs: { $sum: { $cond: [{ $and: [
        { $ne: ['$Results.status', 'Finished'] },
        { $not: { $regexMatch: { input: { $ifNull: ['$Results.status', ''] }, regex: '^\\+\\d+ Lap' } } },
      ]}, 1, 0] } },
      totalPositionsGained: { $sum: { $cond: [
        { $and: [
          { $ne: ['$Results.position', '\\N'] },
          { $ne: ['$Results.grid', '0'] },
          { $gt: [{ $toInt: { $ifNull: ['$Results.grid', '0'] } }, 0] },
        ]},
        { $subtract: [
          { $toInt: { $ifNull: ['$Results.grid',     '0'] } },
          { $toInt: { $ifNull: ['$Results.position', '0'] } },
        ]},
        0,
      ] } },
      classifiedRaces: { $sum: { $cond: [{ $and: [
        { $ne: ['$Results.position', '\\N'] },
        { $gt: [{ $toInt: { $ifNull: ['$Results.grid', '0'] } }, 0] },
      ]}, 1, 0] } },
    }},
  ])
}

export function aggregateCircuitResults(driverId) {
  return Race.aggregate([
    { $match: { 'Results.Driver.driverId': driverId } },
    { $unwind: '$Results' },
    { $match: { 'Results.Driver.driverId': driverId } },
    { $group: {
      _id:         '$Circuit.circuitId',
      circuitName: { $first: '$Circuit.circuitName' },
      lat:         { $first: '$Circuit.Location.lat' },
      long:        { $first: '$Circuit.Location.long' },
      locality:    { $first: '$Circuit.Location.locality' },
      country:     { $first: '$Circuit.Location.country' },
      races:       { $sum: 1 },
      points:      { $sum: { $toDouble: { $ifNull: ['$Results.points', '0'] } } },
      wins:        { $sum: { $cond: [{ $eq: ['$Results.position', '1'] }, 1, 0] } },
      podiums:     { $sum: { $cond: [{ $and: [
        { $ne:  ['$Results.position', '\\N'] },
        { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 3] },
      ]}, 1, 0] } },
    }},
    { $sort: { races: -1 } },
  ])
}

export function aggregateSeasonResults(driverId) {
  return Race.aggregate([
    { $match: { 'Results.Driver.driverId': driverId } },
    { $unwind: '$Results' },
    { $match: { 'Results.Driver.driverId': driverId } },
    { $group: {
      _id:           '$season',
      team:          { $last: '$Results.Constructor.name' },
      constructorId: { $last: '$Results.Constructor.constructorId' },
      points:        { $sum: { $toDouble: { $ifNull: ['$Results.points', '0'] } } },
      wins:          { $sum: { $cond: [{ $eq: ['$Results.position', '1'] }, 1, 0] } },
      podiums:       { $sum: { $cond: [{ $and: [
        { $ne:  ['$Results.position', '\\N'] },
        { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 3] },
      ]}, 1, 0] } },
      poles: { $sum: { $cond: [{ $eq: ['$Results.grid', '1'] }, 1, 0] } },
      races: { $sum: 1 },
    }},
    { $sort: { _id: -1 } },
  ])
}

export function aggregateTeammates(driverId) {
  return Race.aggregate([
    { $match: { 'Results.Driver.driverId': driverId } },
    { $addFields: {
      _myResult: { $first: { $filter: {
        input: '$Results',
        cond:  { $eq: ['$$this.Driver.driverId', driverId] },
      }}},
    }},
    { $addFields: {
      _teammates: { $filter: {
        input: '$Results',
        cond: { $and: [
          { $eq: ['$$this.Constructor.constructorId', '$_myResult.Constructor.constructorId'] },
          { $ne: ['$$this.Driver.driverId', driverId] },
        ]},
      }},
    }},
    { $unwind: { path: '$_teammates', preserveNullAndEmptyArrays: false } },
    { $group: {
      _id: {
        teammateId:    '$_teammates.Driver.driverId',
        constructorId: '$_myResult.Constructor.constructorId',
      },
      givenName:           { $first: '$_teammates.Driver.givenName' },
      familyName:          { $first: '$_teammates.Driver.familyName' },
      teamName:            { $first: '$_myResult.Constructor.name' },
      activeConstructorId: { $last:  '$_myResult.Constructor.constructorId' },
      seasons:             { $addToSet: '$season' },
    }},
    { $sort: { seasons: -1 } },
  ])
}

export async function findTeammateMetadata(driverIds) {
  return Driver.find({ driverId: { $in: driverIds } })
    .select('driverId code photoUrl')
    .lean()
}

export function aggregateRaceResults(driverId, year) {
  return Race.find({ season: String(year), 'Results.Driver.driverId': driverId })
    .select('round raceName Results')
    .sort({ round: 1 })
    .lean()
}

export function aggregateFieldResults(year) {
  return Race.find({ season: String(year) })
    .select('round Results')
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
