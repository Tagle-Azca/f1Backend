import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
import { buildDriverName, roundPoints, normalizeRaceName } from '../utils/formatters.js'
import { countCassandraFastestLaps } from '../services/driverStatsService.js'

export async function getDriverStats(req, res, next) {
  try {
    const { id } = req.params

    const [driver, agg] = await Promise.all([
      Driver.findOne({ driverId: id }).lean(),
      Race.aggregate([
        { $match: { 'Results.Driver.driverId': id } },
        { $unwind: '$Results' },
        { $match: { 'Results.Driver.driverId': id } },
        {
          $group: {
            _id:     null,
            wins:    { $sum: { $cond: [{ $eq: ['$Results.position', '1'] }, 1, 0] } },
            podiums: {
              $sum: {
                $cond: [
                  { $and: [
                    { $ne: ['$Results.position', '\\N'] },
                    { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 3] },
                  ]},
                  1, 0,
                ],
              },
            },
            races:        { $sum: 1 },
            points:       { $sum: { $toDouble: { $ifNull: ['$Results.points', '0'] } } },
            seasons:      { $addToSet: '$season' },
            teams:        { $addToSet: '$Results.Constructor.name' },
            polePositions:{
              $sum: { $cond: [{ $eq: ['$Results.grid', '1'] }, 1, 0] },
            },
            fastestLaps: {
              $sum: {
                $cond: [{ $eq: ['$Results.FastestLap.rank', '1'] }, 1, 0],
              },
            },
            top10s: {
              $sum: {
                $cond: [
                  { $and: [
                    { $ne: ['$Results.position', '\\N'] },
                    { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 10] },
                  ]},
                  1, 0,
                ],
              },
            },
            dnfs: {
              $sum: {
                $cond: [
                  { $and: [
                    { $ne: ['$Results.status', 'Finished'] },
                    { $not: { $regexMatch: { input: { $ifNull: ['$Results.status', ''] }, regex: '^\\+\\d+ Lap' } } },
                  ]},
                  1, 0,
                ],
              },
            },
            // grid - position: positive = gained places, only for classified finishes
            totalPositionsGained: {
              $sum: {
                $cond: [
                  { $and: [
                    { $ne: ['$Results.position', '\\N'] },
                    { $ne: ['$Results.grid', '0'] },      // grid 0 = pit-lane start, skip
                    { $gt: [{ $toInt: { $ifNull: ['$Results.grid', '0'] } }, 0] },
                  ]},
                  { $subtract: [
                    { $toInt: { $ifNull: ['$Results.grid',     '0'] } },
                    { $toInt: { $ifNull: ['$Results.position', '0'] } },
                  ]},
                  0,
                ],
              },
            },
            classifiedRaces: {
              $sum: {
                $cond: [
                  { $and: [
                    { $ne: ['$Results.position', '\\N'] },
                    { $gt: [{ $toInt: { $ifNull: ['$Results.grid', '0'] } }, 0] },
                  ]},
                  1, 0,
                ],
              },
            },
          },
        },
      ]),
    ])

    if (!driver) return res.status(404).json({ message: 'Driver not found' })

    const s = agg[0] || {}
    const cassandraFastestLaps = await countCassandraFastestLaps(driver.permanentNumber)
    const seasons = (s.seasons || []).sort()
    const races   = s.races || 0

    const top10s             = s.top10s   || 0
    const dnfs               = s.dnfs     || 0
    const classifiedRaces    = s.classifiedRaces || 0
    const totalPositionsGained = s.totalPositionsGained || 0

    res.json({
      driver,
      wins:         s.wins        || 0,
      podiums:      s.podiums     || 0,
      races,
      points:       s.points ? (Number.isInteger(s.points) ? s.points : parseFloat(s.points.toFixed(2))) : 0,
      polePositions:s.polePositions || 0,
      fastestLaps:  (s.fastestLaps || 0) + cassandraFastestLaps,
      teams:        (s.teams || []).filter(Boolean),
      firstSeason:  seasons[0]    || null,
      lastSeason:   seasons[seasons.length - 1] || null,
      totalSeasons: seasons.length,
      // Performance metrics
      top10s,
      dnfs,
      pointsPerRace:      races > 0 ? parseFloat((( s.points || 0) / races).toFixed(2)) : 0,
      top10Rate:          races > 0 ? parseFloat(((top10s / races) * 100).toFixed(1))   : 0,
      dnfRate:            races > 0 ? parseFloat(((dnfs    / races) * 100).toFixed(1))  : 0,
      avgPositionsGained: classifiedRaces > 0
        ? parseFloat((totalPositionsGained / classifiedRaces).toFixed(2))
        : 0,
    })
  } catch (err) { next(err) }
}

export async function getDriverCircuits(req, res, next) {
  try {
    const { id } = req.params
    const results = await Race.aggregate([
      { $match: { 'Results.Driver.driverId': id } },
      { $unwind: '$Results' },
      { $match: { 'Results.Driver.driverId': id } },
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
          { $ne: ['$Results.position', '\\N'] },
          { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 3] },
        ]}, 1, 0] } },
      }},
      { $sort: { races: -1 } },
    ])
    res.json(results)
  } catch (err) { next(err) }
}

export async function getDriverSeasons(req, res, next) {
  try {
    const { id } = req.params
    const results = await Race.aggregate([
      { $match: { 'Results.Driver.driverId': id } },
      { $unwind: '$Results' },
      { $match: { 'Results.Driver.driverId': id } },
      {
        $group: {
          _id:         '$season',
          team:        { $last: '$Results.Constructor.name' },
          constructorId: { $last: '$Results.Constructor.constructorId' },
          points:      { $sum: { $toDouble: { $ifNull: ['$Results.points', '0'] } } },
          wins:        { $sum: { $cond: [{ $eq: ['$Results.position', '1'] }, 1, 0] } },
          podiums:     { $sum: { $cond: [{ $and: [
            { $ne: ['$Results.position', '\\N'] },
            { $lte: [{ $toInt: { $ifNull: ['$Results.position', '99'] } }, 3] },
          ]}, 1, 0] } },
          poles:       { $sum: { $cond: [{ $eq: ['$Results.grid', '1'] }, 1, 0] } },
          races:       { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
    ])
    res.json(results.map(r => ({
      season:        r._id,
      team:          r.team,
      constructorId: r.constructorId,
      points:        roundPoints(r.points),
      wins:          r.wins,
      podiums:       r.podiums,
      poles:         r.poles,
      races:         r.races,
    })))
  } catch (err) { next(err) }
}

// ── Driver ego-network ────────────────────────────────────────────────────────
// GET /stats/driver/:id/network
// Returns: { nodes: [...], edges: [...] }
//
// Nodes: activeDriver + direct teammates (type = 'driver')
// Edges: activeDriver → teammate, one edge per (driverId, constructorId) pair,
//        seasons[] contains every season they shared that constructor.

export async function getDriverNetwork(req, res, next) {
  try {
    const { id } = req.params

    const [activeDriver, teammateAgg] = await Promise.all([
      Driver.findOne({ driverId: id }).lean(),

      // Single aggregation: find teammates per (season, constructor)
      Race.aggregate([
        // Races where the active driver participated
        { $match: { 'Results.Driver.driverId': id } },

        // Isolate the active driver's result to get their constructor
        { $addFields: {
          _myResult: {
            $first: {
              $filter: {
                input: '$Results',
                cond:  { $eq: ['$$this.Driver.driverId', id] },
              },
            },
          },
        }},

        // All other results from the same constructor in the same race
        { $addFields: {
          _teammates: {
            $filter: {
              input: '$Results',
              cond: {
                $and: [
                  { $eq: ['$$this.Constructor.constructorId', '$_myResult.Constructor.constructorId'] },
                  { $ne: ['$$this.Driver.driverId', id] },
                ],
              },
            },
          },
        }},

        // One document per teammate entry
        { $unwind: { path: '$_teammates', preserveNullAndEmptyArrays: false } },

        // Group: one edge per (teammate, constructor), accumulate seasons
        { $group: {
          _id: {
            teammateId:    '$_teammates.Driver.driverId',
            constructorId: '$_myResult.Constructor.constructorId',
          },
          givenName:         { $first: '$_teammates.Driver.givenName' },
          familyName:        { $first: '$_teammates.Driver.familyName' },
          teamName:          { $first: '$_myResult.Constructor.name' },
          activeConstructorId: { $last: '$_myResult.Constructor.constructorId' },
          seasons:           { $addToSet: '$season' },
        }},

        { $sort: { 'seasons': -1 } },
      ]),
    ])

    if (!activeDriver) return res.status(404).json({ message: 'Driver not found' })

    // Fetch Driver docs for codes + photos of all teammates in one query
    const teammateIds = [...new Set(teammateAgg.map(e => e._id.teammateId))]
    const driverDocs  = await Driver.find({ driverId: { $in: teammateIds } })
      .select('driverId code photoUrl')
      .lean()
    const driverMeta = Object.fromEntries(driverDocs.map(d => [d.driverId, d]))

    // ── Build nodes ───────────────────────────────────────────────────────────
    const nodeMap = new Map()

    // Active driver (centre of the ego-network)
    nodeMap.set(id, {
      id,
      label:         activeDriver.code || id.substring(0, 3).toUpperCase(),
      fullName:      `${activeDriver.givenName} ${activeDriver.familyName}`,
      type:          'activeDriver',
      photoUrl:      activeDriver.photoUrl || null,
      constructorId: teammateAgg[0]?.activeConstructorId || null,
    })

    // Teammate nodes
    for (const edge of teammateAgg) {
      const tmId = edge._id.teammateId
      if (nodeMap.has(tmId)) continue
      const meta = driverMeta[tmId] || {}
      nodeMap.set(tmId, {
        id:            tmId,
        label:         meta.code || tmId.substring(0, 3).toUpperCase(),
        fullName:      `${edge.givenName} ${edge.familyName}`.trim(),
        type:          'driver',
        photoUrl:      meta.photoUrl || null,
        constructorId: edge._id.constructorId,
      })
    }

    // ── Build edges ───────────────────────────────────────────────────────────
    const edges = teammateAgg.map(edge => ({
      source:        id,
      target:        edge._id.teammateId,
      seasons:       edge.seasons.sort(),
      constructorId: edge._id.constructorId,
      teamName:      edge.teamName,
    }))

    res.json({ nodes: [...nodeMap.values()], edges })
  } catch (err) { next(err) }
}

export async function getHistoricalPerformance(req, res, next) {
  try {
    const { driverId, year } = req.query
    if (!driverId || !year) return res.status(400).json({ message: 'driverId and year are required' })

    const [driverRaces, allRaces] = await Promise.all([
      Race.find({ season: String(year), 'Results.Driver.driverId': driverId })
        .select('round raceName Results')
        .sort({ round: 1 })
        .lean(),
      Race.find({ season: String(year) })
        .select('round Results')
        .lean(),
    ])

    if (!driverRaces.length) return res.json({ races: [], stats: null, reliability: {} })

    const seasonMaxPoints = allRaces.reduce((sum, race) => {
      const best = Math.max(0, ...(race.Results || []).map(r => parseFloat(r.points) || 0))
      return sum + best
    }, 0)

    const raceResults = []
    const reliability = {}
    let wins = 0, podiums = 0, poles = 0, fastestLaps = 0, points = 0, finishes = 0

    for (const race of driverRaces.sort((a, b) => Number(a.round) - Number(b.round))) {
      const result = race.Results?.find(r => r.Driver?.driverId === driverId)
      if (!result) continue

      const pos    = parseInt(result.position)
      const grid   = parseInt(result.grid)
      const status = result.status || 'Unknown'
      const pts    = parseFloat(result.points) || 0
      const fin    = status === 'Finished' || /^\+\d+ Lap/.test(status)

      raceResults.push({
        round:    Number(race.round),
        raceName: normalizeRaceName(race.raceName),
        grid:     isNaN(grid) ? null : grid,
        position: isNaN(pos)  ? null : pos,
        status,
        points:   pts,
        finished: fin,
      })

      reliability[status] = (reliability[status] || 0) + 1
      if (!isNaN(pos) && pos === 1) wins++
      if (!isNaN(pos) && pos <= 3)  podiums++
      if (!isNaN(grid) && grid === 1) poles++
      if (result.FastestLap?.rank === '1') fastestLaps++
      points += pts
      if (fin) finishes++
    }

    const total = raceResults.length
    res.json({
      races: raceResults,
      stats: {
        wins,
        podiums,
        poles,
        fastestLaps,
        points:       roundPoints(points),
        maxPoints:    roundPoints(seasonMaxPoints),
        races:        total,
        finishes,
        dnfs:         total - finishes,
        reliability:  total ? Math.round((finishes / total) * 100) : 0,
      },
      reliability,
    })
  } catch (err) { next(err) }
}
