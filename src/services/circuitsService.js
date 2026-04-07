import * as circuitRepository from '../repositories/circuitRepository.js'
import * as raceRepository    from '../repositories/raceRepository.js'

// In-memory cache — circuit stats barely change (only after a seed)
const TTL = 60 * 60 * 1000 // 1 hour
let _statsCache    = null
let _statsCachedAt = 0

/**
 * Aggregated race count and last-race metadata for every circuit.
 * Results are cached in memory for 1 hour.
 * @returns {{ countMap: object, lastRaceMap: object }}
 */
async function getCircuitStats() {
  if (_statsCache && Date.now() - _statsCachedAt < TTL) return _statsCache

  const [raceCounts, lastRaces] = await Promise.all([
    raceRepository.aggregateCircuitRaceCounts(),
    raceRepository.aggregateCircuitLastRaces(),
  ])

  _statsCache = {
    countMap:    Object.fromEntries(raceCounts.map(r => [r._id, r.count])),
    lastRaceMap: Object.fromEntries(lastRaces.map(r => [r._id, { lastRaceName: r.lastRaceName, lastSeason: r.lastSeason }])),
  }
  _statsCachedAt = Date.now()
  return _statsCache
}

/**
 * Returns all circuits matching the given filters, enriched with raceCount and lastRaceName.
 * @param {{ search?: string, country?: string }} filters
 * @returns {object[]}
 */
export async function listCircuits(filters = {}) {
  const [circuits, { countMap, lastRaceMap }] = await Promise.all([
    circuitRepository.findAll(filters),
    getCircuitStats(),
  ])

  return circuits.map(c => ({
    ...c,
    raceCount:    countMap[c.circuitId]              || 0,
    lastRaceName: lastRaceMap[c.circuitId]?.lastRaceName || null,
    lastSeason:   lastRaceMap[c.circuitId]?.lastSeason   || null,
  }))
}

/**
 * Returns a single circuit by circuitId, or null if not found.
 * @param {string} circuitId
 * @returns {object|null}
 */
export async function getCircuit(circuitId) {
  const circuit = await circuitRepository.findById(circuitId)
  return circuit || null
}
