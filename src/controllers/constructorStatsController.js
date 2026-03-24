import Race    from '../models/Race.js'
import Circuit from '../models/Circuit.js'
import { buildDriverName, roundPoints } from '../utils/formatters.js'
import { cached } from '../utils/cache.js'
import { F1_HEADERS } from '../utils/http.js'

// Fetch race results from Jolpica to fill FastestLap/QualifyingResults gaps
async function enrichFromJolpica(race) {
  if (!race?.season || !race?.round) return
  try {
    const [resResp, qualiResp] = await Promise.allSettled([
      fetch(`https://api.jolpi.ca/ergast/f1/${race.season}/${race.round}/results.json`,
        { headers: F1_HEADERS, signal: AbortSignal.timeout(4000) }),
      fetch(`https://api.jolpi.ca/ergast/f1/${race.season}/${race.round}/qualifying.json`,
        { headers: F1_HEADERS, signal: AbortSignal.timeout(4000) }),
    ])

    // Merge FastestLap per driver if missing in MongoDB
    const hasFastest = (race.Results || []).some(r => r.FastestLap?.Time?.time)
    if (!hasFastest && resResp.status === 'fulfilled' && resResp.value.ok) {
      const json = await resResp.value.json()
      const jResults = json?.MRData?.RaceTable?.Races?.[0]?.Results || []
      for (const result of race.Results || []) {
        const jr = jResults.find(r => r.Driver?.driverId === result.Driver?.driverId)
        if (jr?.FastestLap) result.FastestLap = jr.FastestLap
      }
    }

    // Merge QualifyingResults if missing in MongoDB
    const hasQuali = (race.QualifyingResults || []).length > 0
    if (!hasQuali && qualiResp.status === 'fulfilled' && qualiResp.value.ok) {
      const json = await qualiResp.value.json()
      const jQuali = json?.MRData?.RaceTable?.Races?.[0]?.QualifyingResults || []
      if (jQuali.length) race.QualifyingResults = jQuali
    }
  } catch (_) { /* non-critical — degrade gracefully */ }
}

const STATS_TTL = 10 * 60 * 1000 // 10 min — historical data changes rarely

export async function getCircuitHistory(req, res, next) {
  try {
    const { id } = req.params
    const [circuit, races, lastRace] = await Promise.all([
      Circuit.findOne({ circuitId: id }).lean(),
      Race.find({ 'Circuit.circuitId': id })
        .select('season round raceName date Results QualifyingResults')
        .sort({ season: -1 })
        .lean(),
      // Full document for the most recent completed race — no .select() so every field
      // (Results.FastestLap, QualifyingResults with Q1/Q2/Q3, grid, etc.) is guaranteed.
      Race.findOne({ 'Circuit.circuitId': id, 'Results.0': { $exists: true } })
        .sort({ season: -1 })
        .lean(),
    ])
    if (!circuit) return res.status(404).json({ message: 'Circuit not found' })

    // If lastRace is missing FastestLap or QualifyingResults, pull them live from Jolpica
    if (lastRace) await enrichFromJolpica(lastRace)

    res.json({ circuit, races, lastRace: lastRace || null })
  } catch (err) { next(err) }
}

async function computeConstructorStats(id) {
    const races = await Race.find({ 'Results.Constructor.constructorId': id })
      .select('season round raceName Results QualifyingResults SprintResults')
      .lean()

    if (!races.length) return null

    let wins = 0, podiums = 0, points = 0, poles = 0
    let totalEntries = 0, classifiedEntries = 0
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
        const classified = r.status === 'Finished' || r.status?.startsWith('+')

        totalEntries++
        if (classified) classifiedEntries++

        if (!isNaN(pos)) {
          if (pos === 1) { wins++; s.wins++ }
          if (pos <= 3) raceHasPodium = true
        }
        points += pts
        s.points += pts

        if (r.Driver?.driverId) {
          if (!s.drivers.has(r.Driver.driverId)) {
            s.drivers.set(r.Driver.driverId, { name: buildDriverName(r.Driver), wins: 0, points: 0 })
          }
          const dStats = s.drivers.get(r.Driver.driverId)
          dStats.points += pts
          if (!isNaN(pos) && pos === 1) dStats.wins++
        }
      }
      if (raceHasPodium) podiums++

      // Sprint race points (2021+)
      const mySprintResults = race.SprintResults?.filter(r => r.Constructor?.constructorId === id) || []
      for (const r of mySprintResults) {
        const pts = parseFloat(r.points) || 0
        points += pts
        s.points += pts
        if (r.Driver?.driverId && s.drivers.has(r.Driver.driverId)) {
          s.drivers.get(r.Driver.driverId).points += pts
        }
      }

      const hasPole = race.QualifyingResults?.some(
        q => q.Constructor?.constructorId === id && q.position === '1'
      )
      if (hasPole) poles++
    }

    const name = races[0].Results.find(r => r.Constructor?.constructorId === id)?.Constructor?.name || id

    // Determine championship seasons via single aggregate
    const seasonYears = [...seasonsMap.keys()]
    const seasonStandings = await Race.aggregate([
      { $match: { season: { $in: seasonYears } } },
      { $project: {
        season: 1,
        allResults: { $concatArrays: [
          { $ifNull: ['$Results', []] },
          { $ifNull: ['$SprintResults', []] },
        ]},
      }},
      { $unwind: '$allResults' },
      { $group: {
        _id: { season: '$season', ctor: '$allResults.Constructor.constructorId' },
        pts: { $sum: { $toDouble: { $ifNull: ['$allResults.points', '0'] } } },
      }},
      { $sort: { '_id.season': 1, pts: -1 } },
      { $group: { _id: '$_id.season', topCtor: { $first: '$_id.ctor' }, topPts: { $first: '$pts' } } },
    ])

    const championSeasons = seasonStandings
      .filter(s => s.topCtor === id)
      .map(s => s._id)
      .sort()

    const reliability = totalEntries > 0
      ? Math.round((classifiedEntries / totalEntries) * 1000) / 10
      : null

    const seasonList = [...seasonsMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([season, d]) => ({
        season,
        wins:     d.wins,
        points:   roundPoints(d.points),
        races:    d.races,
        champion: championSeasons.includes(season),
        drivers:  [...d.drivers.entries()].map(([dId, dr]) => ({
          id: dId, name: dr.name, wins: dr.wins, points: roundPoints(dr.points),
        })),
      }))

    const allSeasons = seasonList.map(s => s.season)

    return {
      constructorId: id,
      name,
      stats: {
        seasons:        seasonsMap.size,
        firstSeason:    allSeasons[allSeasons.length - 1],
        lastSeason:     allSeasons[0],
        races:          races.length,
        wins,
        podiums,
        poles,
        points:         roundPoints(points),
        championships:  championSeasons.length,
        championSeasons,
        reliability,
      },
      seasons: seasonList,
    }
}

export async function getConstructorStats(req, res, next) {
  try {
    const { id } = req.params
    const data = await cached(`ctor-stats:${id}`, STATS_TTL, () => computeConstructorStats(id))
    if (!data) return res.status(404).json({ message: 'Constructor not found' })
    res.json(data)
  } catch (err) { next(err) }
}
