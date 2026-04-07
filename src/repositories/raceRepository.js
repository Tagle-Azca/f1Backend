import Race from '../models/Race.js'

/** All races for a season, sorted by round asc. */
export function findBySeasonSorted(season, selectFields) {
  const q = Race.find({ season }).sort({ round: 1 })
  if (selectFields) q.select(selectFields)
  return q.lean()
}

/** Races for a season that have at least one Result entry, sorted by round asc. */
export function findBySeasonWithResultsSorted(season) {
  return Race.find({ season, 'Results.0': { $exists: true } })
    .sort({ round: 1 })
    .lean()
}

/** Single race by season + round. */
export function findBySeasonRound(season, round) {
  return Race.findOne({ season, round }).lean()
}

/** Races from a previous season that have Results (used as fallback standings data). */
export function findPreviousSeasonCompleted(prevSeason) {
  return Race.find({ season: prevSeason, 'Results.0': { $exists: true } })
    .sort({ round: 1 })
    .lean()
}

/** Races for a season with only standings-relevant fields. */
export function findBySeasonForStandings(season) {
  return Race.find({ season })
    .select('round raceName date Results SprintResults')
    .sort({ round: 1 })
    .lean()
}

/** Races for a season with calendar-display fields. */
export function findBySeasonForCalendar(season) {
  return Race.find({ season })
    .select('season round raceName date time Circuit Results SprintResults')
    .sort({ round: 1 })
    .lean()
}

/** Upsert race results for a given season + round. */
export function upsertResults(season, round, data) {
  return Race.updateOne({ season, round }, { $set: data }, { upsert: true })
}

/** Aggregate races across all seasons for a given circuitId, sorted by season desc. */
export function findAllSeasonsForCircuit(circuitId) {
  return Race.aggregate([
    { $match: { 'Circuit.circuitId': circuitId } },
    { $sort: { season: -1, round: -1 } },
    { $project: {
      season: 1,
      round: 1,
      raceName: 1,
      date: 1,
      Results: 1,
      SprintResults: 1,
    } },
  ])
}

/**
 * Full-text search across race name and circuit fields.
 * @param {RegExp} regex
 * @param {number} limit
 */
export function searchRaces(regex, limit) {
  return Race.find({
    $or: [
      { raceName: regex },
      { 'Circuit.circuitName': regex },
      { 'Circuit.Location.locality': regex },
      { 'Circuit.Location.country': regex },
    ],
  })
    .select('season round raceName Circuit date')
    .sort({ season: -1, round: 1 })
    .limit(limit)
    .lean()
}

/**
 * Aggregate unique constructors matching a regex across all Results.
 * @param {RegExp} regex
 * @param {number} limit
 */
export function searchConstructors(regex, limit) {
  return Race.aggregate([
    { $unwind: '$Results' },
    { $match: { 'Results.Constructor.name': regex } },
    { $group: { _id: '$Results.Constructor.constructorId', name: { $first: '$Results.Constructor.name' } } },
    { $limit: limit },
  ])
}

/**
 * Aggregate races for a season with computed hasResults/hasSprint/winner fields
 * suitable for calendar list display. Sorted by round asc.
 * @param {string} season
 */
export function aggregateCalendarList(season) {
  return Race.aggregate([
    { $match: { season } },
    { $project: {
      season: 1, round: 1, raceName: 1, date: 1, time: 1, Circuit: 1,
      hasResults:          { $gt: [{ $size: { $ifNull: ['$Results', []] } }, 0] },
      hasSprint:           { $gt: [{ $size: { $ifNull: ['$SprintResults', []] } }, 0] },
      hasSprintQualifying: { $gt: [{ $size: { $ifNull: ['$SprintQualifyingResults', []] } }, 0] },
      winner: {
        $let: {
          vars: {
            raceP1: {
              $arrayElemAt: [
                { $filter: {
                  input: { $ifNull: ['$Results', []] },
                  as: 'r', cond: { $eq: ['$$r.position', '1'] }
                }}, 0
              ]
            },
            sprintP1: {
              $arrayElemAt: [
                { $filter: {
                  input: { $ifNull: ['$SprintResults', []] },
                  as: 'r', cond: { $eq: ['$$r.position', '1'] }
                }}, 0
              ]
            }
          },
          in: { $ifNull: ['$$raceP1', '$$sprintP1'] }
        }
      }
    }},
    { $addFields: { _roundNum: { $toInt: '$round' } } },
    { $sort: { _roundNum: 1 } },
    { $project: { _roundNum: 0 } },
  ])
}

/**
 * Aggregate race count per circuitId across all seasons.
 * @returns {Array<{ _id: string, count: number }>}
 */
export function aggregateCircuitRaceCounts() {
  return Race.aggregate([
    { $group: { _id: '$Circuit.circuitId', count: { $sum: 1 } } },
  ])
}

/**
 * Aggregate the most recent race name and season per circuitId.
 * @returns {Array<{ _id: string, lastRaceName: string, lastSeason: string }>}
 */
export function aggregateCircuitLastRaces() {
  return Race.aggregate([
    { $sort: { season: -1, round: -1 } },
    { $group: {
      _id:          '$Circuit.circuitId',
      lastRaceName: { $first: '$raceName' },
      lastSeason:   { $first: '$season' },
    } },
  ])
}

/**
 * Aggregate the most recent race winner for each of the given circuitIds.
 * Used to display last circuit winner on upcoming race cards.
 * @param {string[]} circuitIds
 */
export function findLastWinnersForCircuits(circuitIds) {
  return Race.aggregate([
    { $match: { 'Circuit.circuitId': { $in: circuitIds }, 'Results.0': { $exists: true } } },
    { $sort: { season: -1 } },
    { $group: {
      _id: '$Circuit.circuitId',
      season: { $first: '$season' },
      winner: { $first: {
        $arrayElemAt: [
          { $filter: { input: '$Results', as: 'r', cond: { $eq: ['$$r.position', '1'] } } },
          0
        ]
      }}
    }}
  ])
}
