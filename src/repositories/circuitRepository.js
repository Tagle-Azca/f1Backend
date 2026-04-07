import Circuit from '../models/Circuit.js'
import Race    from '../models/Race.js'

/**
 * All circuits with optional filters.
 * @param {{ search?: string, country?: string }} opts
 */
export function findAll({ search, country } = {}) {
  const filter = {}
  if (country) filter['Location.country'] = { $regex: country, $options: 'i' }
  if (search) {
    filter.$or = [
      { circuitName:          { $regex: search, $options: 'i' } },
      { 'Location.country':   { $regex: search, $options: 'i' } },
      { 'Location.locality':  { $regex: search, $options: 'i' } },
    ]
  }
  return Circuit.find(filter).sort({ circuitName: 1 }).lean()
}

/** Single circuit by circuitId. */
export function findById(circuitId) {
  return Circuit.findOne({ circuitId }).lean()
}

/**
 * Search circuits by name/country/locality regex.
 * @param {RegExp} regex
 * @param {number} limit
 */
export function searchByName(regex, limit) {
  return Circuit.find({ $or: [{ circuitName: regex }, { 'Location.country': regex }, { 'Location.locality': regex }] })
    .select('circuitId circuitName Location')
    .limit(limit)
    .lean()
}

/**
 * Aggregate all races held at a circuit across all seasons, sorted by season desc.
 * Returns raw aggregate documents from the Race collection.
 */
export function findRaceHistoryForCircuit(circuitId) {
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
