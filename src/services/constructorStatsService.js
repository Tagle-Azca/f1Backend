import { buildDriverName, roundPoints } from '../utils/formatters.js'
import { cached } from '../utils/cache.js'
import * as raceRepo from '../repositories/raceRepository.js'
import * as circuitRepo from '../repositories/circuitRepository.js'
import * as jolpica from '../repositories/jolpicaRepository.js'
import { queryRaceMetaByYear } from '../repositories/telemetryRepository.js'
import { getOpenF1RaceSessions } from '../repositories/openf1Repository.js'

const STATS_TTL = 10 * 60 * 1000

async function enrichFromJolpica(race) {
  if (!race?.season || !race?.round) return
  try {
    const [raceData, qualiResults] = await Promise.allSettled([
      jolpica.fetchRoundResults(race.season, race.round),
      jolpica.fetchQualifyingByRound(race.season, race.round),
    ])

    const hasFastest = (race.Results || []).some(r => r.FastestLap?.Time?.time)
    if (!hasFastest && raceData.status === 'fulfilled' && raceData.value) {
      const jResults = raceData.value.Results || []
      for (const result of race.Results || []) {
        const jr = jResults.find(r => r.Driver?.driverId === result.Driver?.driverId)
        if (jr?.FastestLap) result.FastestLap = jr.FastestLap
      }
    }

    const hasQuali = (race.QualifyingResults || []).length > 0
    if (!hasQuali && qualiResults.status === 'fulfilled' && qualiResults.value?.length) {
      race.QualifyingResults = qualiResults.value
    }
  } catch (_) {}
}

export async function getCircuitHistoryData(id) {
  const [circuit, races, lastRace] = await Promise.all([
    circuitRepo.findById(id),
    raceRepo.findByCircuitId(id),
    raceRepo.findLastCompletedByCircuitId(id),
  ])

  if (lastRace) await enrichFromJolpica(lastRace)

  let cassandraRaceId = null
  const norm = s => (s || '').toLowerCase().replace(' grand prix', '').trim()

  if (lastRace) {
    const needle = norm(lastRace.raceName)
    const season = String(lastRace.season)

    // 1. Try Cassandra race_meta first
    try {
      const rows  = await queryRaceMetaByYear(lastRace.season)
      const match = rows.find(r => {
        const hay = norm(r.race_name)
        return hay === needle || hay.includes(needle) || needle.includes(hay)
      })
      if (match) cassandraRaceId = match.race_id
    } catch {}

    // 2. Fallback to OpenF1 sessions catalogue filtered by year
    if (!cassandraRaceId) {
      try {
        const sessions = await getOpenF1RaceSessions()
        const match = sessions.find(s => {
          const hay = norm(s.meeting_name)
          return String(s.year) === season &&
            (hay === needle || hay.includes(needle.slice(0, 5)) || needle.includes(hay.slice(0, 5)))
        })
        if (match) cassandraRaceId = `${match.year}_${match.session_key}`
      } catch {}
    }
  }

  // 3. No MongoDB race found — match circuitId directly against OpenF1 catalogue (most recent completed)
  if (!cassandraRaceId) {
    try {
      const normId      = norm(id.replace(/_/g, ' '))
      const now         = new Date()
      const currentYear = now.getFullYear()
      const sessions    = await getOpenF1RaceSessions()
      const match       = sessions
        .filter(s => {
          if (s.year >= currentYear) return false
          const end = s.date_end ? new Date(s.date_end) : (s.date_start ? new Date(s.date_start) : null)
          if (!end || end >= now) return false
          const hayName = norm(s.meeting_name)
          const hayLoc  = norm(s.location || '')
          return (hayName && hayName.includes(normId)) ||
                 (hayLoc && (hayLoc === normId || hayLoc.includes(normId)))
        })
        .sort((a, b) => new Date(b.date_end || b.date_start) - new Date(a.date_end || a.date_start))[0]
      if (match) cassandraRaceId = `${match.year}_${match.session_key}`
    } catch {}
  }

  if (!circuit && !lastRace && (!races || !races.length) && !cassandraRaceId) return null

  return { circuit, races, lastRace: lastRace || null, cassandraRaceId }
}

async function computeConstructorStats(id) {
  const races = await raceRepo.findByConstructorIdWithStats(id)
  if (!races.length) return null

  let wins = 0, podiums = 0, points = 0, poles = 0
  let totalEntries = 0, classifiedEntries = 0
  const seasonsMap = new Map()

  for (const race of races) {
    const myResults = race.Results?.filter(r => r.Constructor?.constructorId === id) || []
    if (!myResults.length) continue

    if (!seasonsMap.has(race.season))
      seasonsMap.set(race.season, { wins: 0, points: 0, races: 0, drivers: new Map() })
    const s = seasonsMap.get(race.season)
    s.races++

    let raceHasPodium = false
    for (const r of myResults) {
      const pos        = parseInt(r.position)
      const pts        = parseFloat(r.points) || 0
      const classified = r.status === 'Finished' || r.status?.startsWith('+')

      totalEntries++
      if (classified) classifiedEntries++

      if (!isNaN(pos)) {
        if (pos === 1) { wins++; s.wins++ }
        if (pos <= 3)  raceHasPodium = true
      }
      points   += pts
      s.points += pts

      if (r.Driver?.driverId) {
        if (!s.drivers.has(r.Driver.driverId))
          s.drivers.set(r.Driver.driverId, { name: buildDriverName(r.Driver), wins: 0, points: 0 })
        const dStats = s.drivers.get(r.Driver.driverId)
        dStats.points += pts
        if (!isNaN(pos) && pos === 1) dStats.wins++
      }
    }
    if (raceHasPodium) podiums++

    const mySprintResults = race.SprintResults?.filter(r => r.Constructor?.constructorId === id) || []
    for (const r of mySprintResults) {
      const pts = parseFloat(r.points) || 0
      points   += pts
      s.points += pts
      if (r.Driver?.driverId && s.drivers.has(r.Driver.driverId))
        s.drivers.get(r.Driver.driverId).points += pts
    }

    const hasPole = race.QualifyingResults?.some(
      q => q.Constructor?.constructorId === id && q.position === '1'
    )
    if (hasPole) poles++
  }

  const name = races[0].Results.find(r => r.Constructor?.constructorId === id)?.Constructor?.name || id

  const seasonYears      = [...seasonsMap.keys()]
  const seasonStandings  = await raceRepo.aggregateConstructorSeasonStandings(seasonYears)
  const championSeasons  = seasonStandings.filter(s => s.topCtor === id).map(s => s._id).sort()
  const reliability      = totalEntries > 0
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
      wins, podiums, poles,
      points:         roundPoints(points),
      championships:  championSeasons.length,
      championSeasons,
      reliability,
    },
    seasons: seasonList,
  }
}

export async function getConstructorStatsData(id) {
  return cached(`ctor-stats:${id}`, STATS_TTL, () => computeConstructorStats(id))
}
