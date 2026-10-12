import * as circuitRepository from '../repositories/circuitRepository.js'
import * as raceRepository    from '../repositories/raceRepository.js'
import * as jolpica           from '../repositories/jolpicaRepository.js'
import logger                 from '../utils/logger.js'

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
 * Falls back to Jolpica for circuits that have never hosted a race yet
 * (e.g. a track debuting this season) — our MongoDB Circuit collection is
 * only populated from past results, so a brand-new venue wouldn't be there.
 * @param {string} circuitId
 * @returns {object|null}
 */
export async function getCircuit(circuitId) {
  const circuit = await circuitRepository.findById(circuitId)
  if (circuit) return circuit

  try {
    const jc = await jolpica.fetchCircuitById(circuitId)
    if (!jc) return null
    return {
      circuitId:    jc.circuitId,
      circuitName:  jc.circuitName,
      url:          jc.url || null,
      Location:     jc.Location || {},
      trackCoords:  null,
      trackFetched: false,
      isNew:        true, // no race history yet — frontend can show a "debut" note
    }
  } catch (err) {
    logger.warn({ err: err.message, circuitId }, '[Circuits] Jolpica fallback failed')
    return null
  }
}
