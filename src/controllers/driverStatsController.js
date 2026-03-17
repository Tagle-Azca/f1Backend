import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'
import { buildDriverName, roundPoints, normalizeRaceName } from '../utils/formatters.js'

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
          },
        },
      ]),
    ])

    if (!driver) return res.status(404).json({ message: 'Driver not found' })

    const s = agg[0] || {}
    const seasons = (s.seasons || []).sort()

    res.json({
      driver,
      wins:         s.wins        || 0,
      podiums:      s.podiums     || 0,
      races:        s.races       || 0,
      points:       s.points ? (Number.isInteger(s.points) ? s.points : parseFloat(s.points.toFixed(2))) : 0,
      polePositions:s.polePositions || 0,
      fastestLaps:  s.fastestLaps  || 0,
      teams:        (s.teams || []).filter(Boolean),
      firstSeason:  seasons[0]    || null,
      lastSeason:   seasons[seasons.length - 1] || null,
      totalSeasons: seasons.length,
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
