import Circuit from '../models/Circuit.js'
import Race    from '../models/Race.js'

// In-memory cache — circuit stats barely change (only after a seed)
const TTL = 60 * 60 * 1000 // 1 hour
let _statsCache = null
let _statsCachedAt = 0

async function getCircuitStats() {
  if (_statsCache && Date.now() - _statsCachedAt < TTL) return _statsCache

  const [raceCounts, lastRaces] = await Promise.all([
    Race.aggregate([
      { $group: { _id: '$Circuit.circuitId', count: { $sum: 1 } } },
    ]),
    Race.aggregate([
      { $sort: { season: -1, round: -1 } },
      { $group: { _id: '$Circuit.circuitId', lastRaceName: { $first: '$raceName' }, lastSeason: { $first: '$season' } } },
    ]),
  ])

  _statsCache = {
    countMap:    Object.fromEntries(raceCounts.map(r => [r._id, r.count])),
    lastRaceMap: Object.fromEntries(lastRaces.map(r => [r._id, { lastRaceName: r.lastRaceName, lastSeason: r.lastSeason }])),
  }
  _statsCachedAt = Date.now()
  return _statsCache
}

export async function listCircuits(req, res, next) {
  try {
    const { country, search } = req.query
    const filter = {}
    if (country) filter['Location.country'] = { $regex: country, $options: 'i' }
    if (search) {
      filter.$or = [
        { circuitName:        { $regex: search, $options: 'i' } },
        { 'Location.country': { $regex: search, $options: 'i' } },
        { 'Location.locality':{ $regex: search, $options: 'i' } },
      ]
    }

    const [circuits, { countMap, lastRaceMap }] = await Promise.all([
      Circuit.find(filter).sort({ circuitName: 1 }).lean(),
      getCircuitStats(),
    ])

    res.json(circuits.map(c => ({
      ...c,
      raceCount:    countMap[c.circuitId]    || 0,
      lastRaceName: lastRaceMap[c.circuitId]?.lastRaceName || null,
      lastSeason:   lastRaceMap[c.circuitId]?.lastSeason   || null,
    })))
  } catch (err) { next(err) }
}

export async function getCircuit(req, res, next) {
  try {
    const circuit = await Circuit.findOne({ circuitId: req.params.id }).lean()
    if (!circuit) return res.status(404).json({ message: 'Circuit not found' })
    res.json(circuit)
  } catch (err) { next(err) }
}
