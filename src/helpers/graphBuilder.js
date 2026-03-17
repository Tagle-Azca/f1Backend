import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
import { buildDriverName } from '../utils/formatters.js'

/**
 * Builds a driver-team graph from MongoDB for a given season.
 * Used as fallback when Dgraph is unavailable.
 */
export async function buildGraphFromMongo(season) {
  const races   = await Race.find({ season }).select('Results').lean()
  const drivers = await Driver.find().select('driverId givenName familyName nationality').lean()

  const driverMap      = new Map(drivers.map((d) => [d.driverId, d]))
  const teamsMap       = new Map()  // constructorId → name
  const driverTeamsMap = new Map()  // driverId → Set<constructorId>

  for (const race of races) {
    for (const r of race.Results || []) {
      if (r.Constructor && r.Driver) {
        teamsMap.set(r.Constructor.constructorId, r.Constructor.name)
        const dId = r.Driver.driverId
        if (!driverTeamsMap.has(dId)) driverTeamsMap.set(dId, new Set())
        driverTeamsMap.get(dId).add(r.Constructor.constructorId)
      }
    }
  }

  const nodesMap = new Map()
  const links    = []

  for (const [teamId, name] of teamsMap) {
    nodesMap.set(`team_${teamId}`, { id: `team_${teamId}`, name, type: 'Team' })
  }

  for (const [driverId, teamIds] of driverTeamsMap) {
    const d = driverMap.get(driverId)
    if (!d) continue
    const nodeId = `driver_${driverId}`
    nodesMap.set(nodeId, {
      id:          nodeId,
      name:        buildDriverName(d),
      type:        'Driver',
      nationality: d.nationality,
    })
    for (const teamId of teamIds) {
      if (teamsMap.has(teamId)) {
        links.push({ source: nodeId, target: `team_${teamId}` })
      }
    }
  }

  return { nodes: Array.from(nodesMap.values()), links }
}
