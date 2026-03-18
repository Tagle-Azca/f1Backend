import Race    from '../models/Race.js'
import Circuit from '../models/Circuit.js'
import { buildDriverName, roundPoints } from '../utils/formatters.js'

export async function getCircuitHistory(req, res, next) {
  try {
    const { id } = req.params
    const [circuit, races] = await Promise.all([
      Circuit.findOne({ circuitId: id }).lean(),
      Race.find({ 'Circuit.circuitId': id })
        .select('season round raceName date Results')
        .sort({ season: -1 })
        .lean(),
    ])
    if (!circuit) return res.status(404).json({ message: 'Circuit not found' })
    res.json({ circuit, races })
  } catch (err) { next(err) }
}

export async function getConstructorStats(req, res, next) {
  try {
    const { id } = req.params

    const races = await Race.find({ 'Results.Constructor.constructorId': id })
      .select('season round raceName Results QualifyingResults')
      .lean()

    if (!races.length) return res.status(404).json({ message: 'Constructor not found' })

    let wins = 0, podiums = 0, points = 0, poles = 0
    const seasonsMap = new Map()

    for (const race of races) {
      const myResults = race.Results?.filter(r => r.Constructor?.constructorId === id) || []
      if (!myResults.length) continue

      if (!seasonsMap.has(race.season)) {
        seasonsMap.set(race.season, { wins: 0, points: 0, races: 0, drivers: new Map() })
      }
      const s = seasonsMap.get(race.season)
      s.races++

      let raceHasPodium = false
      for (const r of myResults) {
        const pos = parseInt(r.position)
        const pts = parseFloat(r.points) || 0
        if (!isNaN(pos)) {
          if (pos === 1) { wins++; s.wins++ }
          if (pos <= 3) raceHasPodium = true
        }
        points += pts
        s.points += pts
        if (r.Driver?.driverId) {
          s.drivers.set(r.Driver.driverId, buildDriverName(r.Driver))
        }
      }
      if (raceHasPodium) podiums++

      const hasPole = race.QualifyingResults?.some(
        q => q.Constructor?.constructorId === id && q.position === '1'
      )
      if (hasPole) poles++
    }

    const name = races[0].Results.find(r => r.Constructor?.constructorId === id)?.Constructor?.name || id

    const seasonList = [...seasonsMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([season, d]) => ({
        season,
        wins:    d.wins,
        points:  roundPoints(d.points),
        races:   d.races,
        drivers: [...d.drivers.entries()].map(([dId, dName]) => ({ id: dId, name: dName })),
      }))

    const allSeasons = seasonList.map(s => s.season)

    res.json({
      constructorId: id,
      name,
      stats: {
        seasons:     seasonsMap.size,
        firstSeason: allSeasons[allSeasons.length - 1],
        lastSeason:  allSeasons[0],
        races:       races.length,
        wins,
        podiums,
        poles,
        points: roundPoints(points),
      },
      seasons: seasonList,
    })
  } catch (err) { next(err) }
}
