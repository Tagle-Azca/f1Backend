import { dgraphQuery, getDgraphClient } from '../config/dgraph.js'
import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
import { buildGraphFromMongo } from '../helpers/graphBuilder.js'
import { buildDriverName, roundPoints } from '../utils/formatters.js'

// ── Shared helpers (only used in this file) ───────────────

/**
 * Computes career stats for a driver from a pre-fetched array of Race documents.
 * Returns { wins, podiums, points, poles, fastestLaps, seasons (Set) }.
 */
function computeCareerStats(races, driverId) {
  let wins = 0, podiums = 0, totalPoints = 0, poles = 0, fastestLaps = 0
  const seasons = new Set()

  for (const race of races) {
    const r = race.Results.find(r => r.Driver?.driverId === driverId)
    if (!r) continue
    seasons.add(race.season)
    const pos = parseInt(r.position)
    if (pos === 1) wins++
    if (pos <= 3) podiums++
    totalPoints += parseFloat(r.points) || 0
    if (r.grid === '1') poles++
    if (r.FastestLap?.rank === '1') fastestLaps++
  }

  return { wins, podiums, points: roundPoints(totalPoints), poles, fastestLaps, seasons }
}

/**
 * Builds a Map of teams (constructorId → { constructorId, name, seasons Set })
 * for a specific driver across all provided races.
 */
function buildDriverTeamMap(races, driverId) {
  const map = new Map()
  for (const race of races) {
    const r = race.Results.find(r => r.Driver?.driverId === driverId)
    if (!r?.Constructor) continue
    const { constructorId, name } = r.Constructor
    if (!map.has(constructorId)) map.set(constructorId, { constructorId, name, seasons: new Set() })
    map.get(constructorId).seasons.add(race.season)
  }
  return map
}

/**
 * Builds a Map of teammates (driverId → { driverId, name, seasons Set, teamIds Set, teams Set })
 * for a specific driver across all provided races. Both teamIds and team names are tracked
 * so callers can use whichever they need.
 */
function buildTeammateMap(races, driverId) {
  const map = new Map()
  for (const race of races) {
    const myResult = race.Results.find(r => r.Driver?.driverId === driverId)
    if (!myResult?.Constructor) continue
    const { constructorId, name: teamName } = myResult.Constructor

    for (const r of race.Results) {
      if (!r.Driver || r.Driver.driverId === driverId) continue
      if (r.Constructor?.constructorId !== constructorId) continue
      const tmId = r.Driver.driverId
      if (!map.has(tmId)) {
        map.set(tmId, {
          driverId: tmId,
          name:     buildDriverName(r.Driver),
          seasons:  new Set(),
          teamIds:  new Set(),
          teams:    new Set(),
        })
      }
      map.get(tmId).seasons.add(race.season)
      map.get(tmId).teamIds.add(constructorId)
      map.get(tmId).teams.add(teamName)
    }
  }
  return map
}

// ── Route handlers ───────────────────────────────────────

// Returns {nodes, links} ready for react-force-graph
// Uses Dgraph when available, falls back to MongoDB
export async function getDriverNetwork(req, res, next) {
  try {
    const season = req.query.season || '2024'

    // Try Dgraph first
    if (getDgraphClient()) {
      try {
        const query = `
          query {
            drivers(func: type(Driver)) {
              uid name nationality season
              drives_for { uid name }
            }
          }
        `
        const data       = await dgraphQuery(query, {})
        const allDrivers = (data.drivers || []).filter(
          (d) => !season || d.season === season
        )

        if (allDrivers.length > 0) {
          // Deduplicate drivers by name (Dgraph may have dupes if seeded multiple times)
          const seenNames      = new Map()
          const dedupedDrivers = []
          for (const d of allDrivers) {
            if (!d.name) continue
            if (!seenNames.has(d.name)) {
              seenNames.set(d.name, d.uid)
              dedupedDrivers.push(d)
            }
          }

          const nodesMap = new Map()
          const links    = []
          for (const d of dedupedDrivers) {
            nodesMap.set(d.uid, { id: d.uid, name: d.name, type: 'Driver', nationality: d.nationality })
            for (const team of d.drives_for || []) {
              if (!nodesMap.has(team.uid)) {
                nodesMap.set(team.uid, { id: team.uid, name: team.name, type: 'Team' })
              }
              links.push({ source: d.uid, target: team.uid })
            }
          }
          return res.json({ nodes: Array.from(nodesMap.values()), links, source: 'dgraph' })
        }
      } catch (_) { /* fall through to MongoDB */ }
    }

    // MongoDB fallback
    const graph = await buildGraphFromMongo(season)
    res.json({ ...graph, source: 'mongodb' })
  } catch (err) { next(err) }
}

export async function getDriverConnections(req, res, next) {
  try {
    const { driverId } = req.params

    const races = await Race.find({ 'Results.Driver.driverId': driverId })
      .select('season round raceName date Circuit Results')
      .lean()

    if (!races.length) return res.json({ teams: [], teammates: [], debut: null, stats: null })

    races.sort((a, b) => Number(a.season) - Number(b.season) || Number(a.round) - Number(b.round))

    const debutRace   = races[0]
    const debutResult = debutRace.Results.find(r => r.Driver?.driverId === driverId)
    const debut = {
      raceName:    debutRace.raceName,
      season:      debutRace.season,
      round:       debutRace.round,
      date:        debutRace.date,
      circuitName: debutRace.Circuit?.circuitName,
      position:    debutResult?.position,
    }

    const { wins, podiums, points, poles, fastestLaps, seasons } = computeCareerStats(races, driverId)
    const stats = {
      races:       races.length,
      wins, podiums, points, poles, fastestLaps,
      seasons:     seasons.size,
      firstSeason: debutRace.season,
      lastSeason:  races[races.length - 1].season,
    }

    const teams = Array.from(buildDriverTeamMap(races, driverId).values()).map(t => ({
      constructorId: t.constructorId,
      name:          t.name,
      seasons:       [...t.seasons].sort(),
    }))

    const teammates = Array.from(buildTeammateMap(races, driverId).values())
      .map(t => ({
        driverId: t.driverId,
        name:     t.name,
        seasons:  [...t.seasons].sort(),
        teams:    [...t.teams],
      }))
      .sort((a, b) => b.seasons.length - a.seasons.length)

    res.json({ teams, teammates, debut, stats })
  } catch (err) { next(err) }
}

// Full ego-network for a driver across all seasons (no season filter)
export async function getDriverEgoGraph(req, res, next) {
  try {
    const { driverId } = req.params

    const [races, driver] = await Promise.all([
      Race.find({ 'Results.Driver.driverId': driverId })
        .select('season round raceName Circuit Results')
        .lean(),
      Driver.findOne({ driverId })
        .select('driverId givenName familyName nationality photoUrl')
        .lean(),
    ])

    if (!races.length) return res.json({ nodes: [], links: [], stats: null, debut: null })

    races.sort((a, b) => Number(a.season) - Number(b.season) || Number(a.round) - Number(b.round))

    const { wins, podiums, points, poles, fastestLaps, seasons } = computeCareerStats(races, driverId)
    const teamMap     = buildDriverTeamMap(races, driverId)
    const teammateMap = buildTeammateMap(races, driverId)

    // Bulk-fetch teammate photos
    const tmIds    = Array.from(teammateMap.keys())
    const tmDocs   = await Driver.find({ driverId: { $in: tmIds } })
      .select('driverId photoUrl nationality')
      .lean()
    const tmDocMap = new Map(tmDocs.map(d => [d.driverId, d]))

    // Build graph nodes + links
    const nodes = [{
      id:          `driver_${driverId}`,
      name:        driver ? buildDriverName(driver) : driverId,
      type:        'Driver',
      nationality: driver?.nationality || '',
      photoUrl:    driver?.photoUrl    || null,
      isSelf:      true,
    }]
    const links = []

    for (const t of teamMap.values()) {
      nodes.push({
        id:      `team_${t.constructorId}`,
        name:    t.name,
        type:    'Team',
        seasons: [...t.seasons].sort(),
      })
      links.push({ source: `driver_${driverId}`, target: `team_${t.constructorId}`, rel: 'drove_for' })
    }

    for (const t of teammateMap.values()) {
      const doc = tmDocMap.get(t.driverId)
      nodes.push({
        id:          `teammate_${t.driverId}`,
        name:        t.name,
        type:        'Teammate',
        nationality: doc?.nationality || '',
        photoUrl:    doc?.photoUrl    || null,
        seasons:     [...t.seasons].sort(),
        teamIds:     [...t.teamIds],
      })
      for (const teamId of t.teamIds) {
        links.push({ source: `teammate_${t.driverId}`, target: `team_${teamId}`, rel: 'teammate' })
      }
    }

    const debutRace   = races[0]
    const debutResult = debutRace.Results.find(r => r.Driver?.driverId === driverId)

    res.json({
      nodes,
      links,
      stats: {
        races:       races.length,
        wins, podiums, points, poles, fastestLaps,
        seasons:     seasons.size,
        firstSeason: debutRace.season,
        lastSeason:  races[races.length - 1].season,
      },
      debut: {
        raceName:    debutRace.raceName,
        season:      debutRace.season,
        circuitName: debutRace.Circuit?.circuitName || '',
        position:    debutResult?.position || null,
      },
    })
  } catch (err) { next(err) }
}

// Constructor ego-network: team at center, all drivers as spokes
export async function getConstructorEgoGraph(req, res, next) {
  try {
    const { constructorId } = req.params

    const races = await Race.find({ 'Results.Constructor.constructorId': constructorId })
      .select('season raceName Results')
      .lean()

    if (!races.length) return res.json({ nodes: [], links: [] })

    races.sort((a, b) => Number(a.season) - Number(b.season))

    const driverMap = new Map() // driverId → { name, seasons Set }
    let constructorName = constructorId

    for (const race of races) {
      for (const r of race.Results) {
        if (r.Constructor?.constructorId !== constructorId) continue
        if (!r.Driver?.driverId) continue
        constructorName = r.Constructor.name
        const dId = r.Driver.driverId
        if (!driverMap.has(dId)) {
          driverMap.set(dId, { driverId: dId, name: buildDriverName(r.Driver), seasons: new Set() })
        }
        driverMap.get(dId).seasons.add(race.season)
      }
    }

    // Bulk-fetch photos
    const dIds   = [...driverMap.keys()]
    const dDocs  = await Driver.find({ driverId: { $in: dIds } })
      .select('driverId photoUrl nationality').lean()
    const docMap = new Map(dDocs.map(d => [d.driverId, d]))

    const nodes = [{
      id:     `team_${constructorId}`,
      name:   constructorName,
      type:   'Team',
      isSelf: true,
    }]
    const links = []

    for (const d of driverMap.values()) {
      const doc = docMap.get(d.driverId)
      nodes.push({
        id:          `driver_${d.driverId}`,
        name:        d.name,
        type:        'Driver',
        photoUrl:    doc?.photoUrl    || null,
        nationality: doc?.nationality || '',
        seasons:     [...d.seasons].sort(),
      })
      links.push({ source: `team_${constructorId}`, target: `driver_${d.driverId}`, rel: 'drove_for' })
    }

    res.json({ nodes, links, total: driverMap.size, seasons: races.map(r => r.season) })
  } catch (err) { next(err) }
}

export async function getDriverNode(req, res, next) {
  if (!getDgraphClient()) return dgraphUnavailable(res)
  try {
    const { driverId } = req.params
    const query = `
      query driver($id: string) {
        driver(func: uid($id)) {
          uid name nationality
          drives_for { uid name }
          competed_in { uid name date }
        }
      }
    `
    const data = await dgraphQuery(query, { $id: driverId })
    res.json(data.driver?.[0] || null)
  } catch (err) { next(err) }
}
