import * as raceRepository    from '../repositories/raceRepository.js'
import * as driverRepository  from '../repositories/driverRepository.js'
import * as circuitRepository from '../repositories/circuitRepository.js'

/**
 * Search races, drivers, circuits, and constructors by query string.
 *
 * @param {string} query    — raw search string (min 2 chars)
 * @param {number} limit    — max results per category (clamped 1–50, default 12)
 * @returns {{ results: object[] }}
 */
export async function search(query, limit = 12) {
  const lim   = Math.min(Math.max(1, parseInt(limit) || 12), 50)
  const regex = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

  const [races, drivers, circuits, constructors] = await Promise.all([
    raceRepository.searchRaces(regex, lim),
    driverRepository.searchByName(regex, Math.ceil(lim / 2)),
    circuitRepository.searchByName(regex, 4),
    raceRepository.searchConstructors(regex, 4),
  ])

  const results = [
    ...races.map(r => ({
      type:        'race',
      id:          `${r.season}-${r.round}`,
      label:       `${r.season} ${r.raceName}`,
      season:      r.season,
      round:       r.round,
      circuitName: r.Circuit?.circuitName,
      date:        r.date,
    })),
    ...drivers.map(d => ({
      type:        'driver',
      id:          d.driverId,
      label:       `${d.givenName} ${d.familyName}`,
      nationality: d.nationality,
      number:      d.permanentNumber,
    })),
    ...circuits.map(c => ({
      type:     'circuit',
      id:       c.circuitId,
      label:    c.circuitName,
      country:  c.Location?.country,
      locality: c.Location?.locality,
    })),
    ...constructors.map(c => ({
      type:  'constructor',
      id:    c._id,
      label: c.name,
    })),
  ]

  return { results }
}
