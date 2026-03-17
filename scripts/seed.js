#!/usr/bin/env node
/**
 * F1 Platform — Full Seed Script
 * Seeds MongoDB (Jolpica API), Cassandra (OpenF1 API), and Dgraph (HTTP API)
 *
 * Usage:
 *   npm run seed              → seeds all DBs (skips offline ones)
 *   npm run seed -- --mongo   → MongoDB only
 *   npm run seed -- --cassandra
 *   npm run seed -- --dgraph
 */
import 'dotenv/config'
import fs   from 'fs'
import path from 'path'
import os   from 'os'
import mongoose from 'mongoose'
import cassandraDriver from 'cassandra-driver'

import Driver  from '../src/models/Driver.js'
import Circuit from '../src/models/Circuit.js'
import Race    from '../src/models/Race.js'

const JOLPICA  = 'https://api.jolpi.ca/ergast/f1'
const OPENF1   = 'https://api.openf1.org/v1'
const DGRAPH_HTTP = `http://${process.env.DGRAPH_HTTP_HOST || 'localhost'}:8080`

// All F1 seasons since the first championship
const ALL_SEASONS = Array.from({ length: 2026 - 1950 }, (_, i) => String(1950 + i))

// ── Flags ────────────────────────────────────────────────
const args = process.argv.slice(2)
const RUN_ALL         = args.length === 0 || args.every(a => a.startsWith('--'))
const RUN_MONGO       = RUN_ALL || args.includes('--mongo')
const RUN_CASSANDRA   = RUN_ALL || args.includes('--cassandra')
const RUN_DGRAPH      = RUN_ALL || args.includes('--dgraph')
// --all-history → full 1950-present | --from=YEAR → from that year | default → last 5 seasons
const ALL_HISTORY     = args.includes('--all-history')
const FORCE           = args.includes('--force')   // skip the "already seeded" check
const FROM_ARG        = args.find(a => a.startsWith('--from='))
const FROM_YEAR       = FROM_ARG ? parseInt(FROM_ARG.split('=')[1]) : null
const SEASONS         = ALL_HISTORY
  ? ALL_SEASONS
  : FROM_YEAR
    ? ALL_SEASONS.filter(s => parseInt(s) >= FROM_YEAR)
    : Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - 4 + i))

// ── Helpers ──────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJSON(url, retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'F1IntelligencePlatform/1.0 (educational project)',
        },
      })
      if (res.status === 429) {
        const wait = 30000 * i  // 30s, 60s, 90s...
        process.stdout.write(`\n  [Rate limit 429] Esperando ${wait / 1000}s antes de reintentar...\n`)
        await sleep(wait)
        continue
      }
      if (res.status === 401) throw new Error('HTTP 401 — API requires authentication or key')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (err) {
      if (i === retries) throw err
      await sleep(3000 * i)
    }
  }
  throw new Error('Rate limit: agotados todos los reintentos')
}

async function waitForDB(label, testFn, maxAttempts = 24, intervalMs = 5000) {
  console.log(`\n[${label}] Waiting for connection...`)
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await testFn()
      console.log(`[${label}] Ready!`)
      return true
    } catch (err) {
      const remaining = ((maxAttempts - i) * intervalMs) / 1000
      process.stdout.write(`  attempt ${i}/${maxAttempts} — retry in ${intervalMs / 1000}s (${remaining}s max remaining)\r`)
      await sleep(intervalMs)
    }
  }
  console.log(`\n[${label}] Could not connect after ${maxAttempts} attempts — skipping`)
  return false
}

// ══════════════════════════════════════════════════════════
// MONGODB
// ══════════════════════════════════════════════════════════
async function seedMongoDB() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform'

  const ok = await waitForDB('MongoDB', async () => {
    await mongoose.connect(uri)
  }, 6, 3000)
  if (!ok) return

  console.log('\n[MongoDB] Seeding...')
  console.log(`  Seasons to process: ${SEASONS[0]} → ${SEASONS[SEASONS.length - 1]} (${SEASONS.length} seasons)`)
  if (ALL_HISTORY) console.log('  TIP: this will take ~20-40 min. Go grab a coffee.')

  for (const season of SEASONS) {
    try {
      // Cooldown between seasons to avoid rate limiting
      await sleep(3000)

      // Get the actual round list first — used for skip check and round-by-round fetch
      const roundsData = await fetchJSON(`${JOLPICA}/${season}/races.json?limit=100`)
      const rounds     = roundsData.MRData.RaceTable.Races || []
      const expected   = rounds.length
      await sleep(2000)

      const existing = await Race.countDocuments({ season })
      if (!FORCE && expected > 0 && existing >= expected) {
        process.stdout.write(`  [${season}] already seeded (${existing}/${expected} races) — skip\n`)
        continue
      }

      process.stdout.write(`  [${season}] drivers... `)
      const drData  = await fetchJSON(`${JOLPICA}/${season}/drivers.json?limit=100`)
      const drivers = drData.MRData.DriverTable.Drivers
      for (const d of drivers) {
        await Driver.findOneAndUpdate(
          { driverId: d.driverId },
          { ...d, dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth) : undefined },
          { upsert: true, new: true }
        )
      }
      console.log(`${drivers.length} ok`)
      await sleep(2000)

      process.stdout.write(`  [${season}] circuits... `)
      const ciData    = await fetchJSON(`${JOLPICA}/${season}/circuits.json?limit=100`)
      const circuits  = ciData.MRData.CircuitTable.Circuits
      for (const c of circuits) {
        await Circuit.findOneAndUpdate({ circuitId: c.circuitId }, c, { upsert: true, new: true })
      }
      console.log(`${circuits.length} ok`)
      await sleep(2000)

      // Fetch results round by round — avoids Jolpica's hidden result-count cap
      process.stdout.write(`  [${season}] races + results (${expected} rounds)...\n`)
      let saved = 0
      for (const round of rounds) {
        try {
          const resData = await fetchJSON(`${JOLPICA}/${season}/${round.round}/results.json`)
          const race    = resData.MRData.RaceTable.Races?.[0]
          if (race) {
            // Qualifying results (Q1/Q2/Q3)
            try {
              await sleep(1000)
              const qualiData = await fetchJSON(`${JOLPICA}/${season}/${round.round}/qualifying.json`)
              const qualiResults = qualiData.MRData.RaceTable.Races?.[0]?.QualifyingResults
              if (qualiResults?.length) race.QualifyingResults = qualiResults
            } catch (_) { /* no qualifying data yet — skip */ }

            // Sprint results + sprint qualifying (only sprint weekends)
            try {
              await sleep(1000)
              const sprintData = await fetchJSON(`${JOLPICA}/${season}/${round.round}/sprint.json`)
              const sprintResults = sprintData.MRData.RaceTable.Races?.[0]?.SprintResults
              if (sprintResults?.length) race.SprintResults = sprintResults
            } catch (_) { /* not a sprint weekend — skip silently */ }

            try {
              await sleep(1000)
              const sqData = await fetchJSON(`${JOLPICA}/${season}/${round.round}/sprintqualifying.json`)
              const sqResults = sqData.MRData.RaceTable.Races?.[0]?.SprintQualifyingResults
              if (sqResults?.length) race.SprintQualifyingResults = sqResults
            } catch (_) { /* not available — skip */ }

            await Race.findOneAndUpdate(
              { season: race.season, round: race.round },
              race,
              { upsert: true, new: true }
            )
            saved++
          }
          process.stdout.write(`    Round ${round.round}/${expected} ok\r`)
        } catch (err) {
          console.warn(`    Round ${round.round} failed: ${err.message}`)
        }
        await sleep(2000)
      }
      console.log(`  [${season}] ${saved}/${expected} rounds saved       `)
    } catch (err) {
      console.warn(`  [${season}] season failed: ${err.message} — skipping to next season`)
      await sleep(60000) // espera 1 min antes de continuar si falla una temporada entera
    }
  }

  console.log('[MongoDB] Done\n')
}

// ══════════════════════════════════════════════════════════
// CASSANDRA
// ══════════════════════════════════════════════════════════
async function seedCassandra() {
  let client

  const KS = process.env.CASSANDRA_KEYSPACE || 'f1_telemetry'

  const ok = await waitForDB('Cassandra', async () => {
    if (process.env.ASTRA_BUNDLE_B64) {
      const bundlePath = path.join(os.tmpdir(), 'secure-connect-seed.zip')
      fs.writeFileSync(bundlePath, Buffer.from(process.env.ASTRA_BUNDLE_B64, 'base64'))
      client = new cassandraDriver.Client({
        cloud: { secureConnectBundle: bundlePath },
        credentials: {
          username: process.env.ASTRA_CLIENT_ID,
          password: process.env.ASTRA_CLIENT_SECRET,
        },
        keyspace: KS,
      })
    } else {
      client = new cassandraDriver.Client({
        contactPoints: [
          `${process.env.CASSANDRA_HOST || '127.0.0.1'}:${process.env.CASSANDRA_PORT || 9042}`,
        ],
        localDataCenter: process.env.CASSANDRA_DC || 'datacenter1',
      })
    }
    await client.connect()
  }, 24, 5000)
  if (!ok) return

  // ── Schema ───────────────────────────────────────────
  console.log('[Cassandra] Creating schema...')
  const exec = (cql) => client.execute(cql)

  if (!process.env.ASTRA_BUNDLE_B64) {
    await exec(`
      CREATE KEYSPACE IF NOT EXISTS ${KS}
      WITH replication = {'class':'SimpleStrategy','replication_factor':1}
    `)
  }
  await exec(`
    CREATE TABLE IF NOT EXISTS ${KS}.race_meta (
      race_id    text PRIMARY KEY,
      race_name  text,
      session_key int,
      year       int
    )
  `)
  await exec(`
    CREATE TABLE IF NOT EXISTS ${KS}.lap_times (
      race_id    text,
      driver_id  text,
      lap_number int,
      lap_time   float,
      sector1    float,
      sector2    float,
      sector3    float,
      PRIMARY KEY ((race_id, driver_id), lap_number)
    ) WITH CLUSTERING ORDER BY (lap_number ASC)
  `)
  await exec(`
    CREATE TABLE IF NOT EXISTS ${KS}.pit_stops (
      race_id     text,
      driver_id   text,
      stop_number int,
      lap         int,
      duration    float,
      time        text,
      PRIMARY KEY ((race_id, driver_id), stop_number)
    ) WITH CLUSTERING ORDER BY (stop_number ASC)
  `)
  await exec(`
    CREATE TABLE IF NOT EXISTS ${KS}.stints (
      race_id      text,
      driver_id    text,
      stint_number int,
      compound     text,
      lap_start    int,
      lap_end      int,
      tyre_age     int,
      PRIMARY KEY (race_id, driver_id, stint_number)
    ) WITH CLUSTERING ORDER BY (driver_id ASC, stint_number ASC)
  `)
  await exec(`
    CREATE TABLE IF NOT EXISTS ${KS}.race_drivers (
      race_id   text,
      driver_id text,
      acronym   text,
      full_name text,
      team_name text,
      PRIMARY KEY (race_id, driver_id)
    )
  `)
  await exec(`
    CREATE TABLE IF NOT EXISTS ${KS}.race_positions (
      race_id   text,
      driver_id text,
      lap       int,
      position  int,
      PRIMARY KEY ((race_id, driver_id), lap)
    ) WITH CLUSTERING ORDER BY (lap ASC)
  `)

  // ── Data from OpenF1 ─────────────────────────────────
  // OpenF1 has data from 2023 onwards. Use --year=YYYY or --year=2023,2024,2025 for multiple
  const YEAR_ARG   = args.find(a => a.startsWith('--year='))
  const YEAR_VAL   = YEAR_ARG ? YEAR_ARG.split('=')[1] : String(new Date().getFullYear())
  const YEARS      = YEAR_VAL.split(',').map(y => y.trim()).filter(Boolean)

  console.log(`[Cassandra] Fetching sessions from OpenF1 for year(s): ${YEARS.join(', ')}`)

  let sessions = []
  for (const year of YEARS) {
    try {
      const yr = await fetchJSON(`${OPENF1}/sessions?session_name=Race&year=${year}`)
      if (!Array.isArray(yr)) throw new Error('Unexpected response format')
      sessions = sessions.concat(yr)
      console.log(`  ${year}: ${yr.length} races found`)
    } catch (err) {
      console.warn(`  [OpenF1] ${year}: ${err.message} — skipping`)
    }
    await sleep(500)
  }

  if (!sessions.length) {
    console.warn('[OpenF1] No sessions found. Schema is ready but no data seeded.')
    await client.shutdown()
    console.log('[Cassandra] Done (schema only)\n')
    return
  }
  // Filter out future races (OpenF1 returns 404 for races that haven't happened yet)
  const today = new Date()
  const pastSessions = sessions.filter(s => s.date_start && new Date(s.date_start) <= today)
  console.log(`[Cassandra] ${sessions.length} total races, ${pastSessions.length} past/current (${sessions.length - pastSessions.length} future skipped)`)

  // --races=N flag to limit number of races (default: all past)
  const RACES_ARG = args.find(a => a.startsWith('--races='))
  const RACES_LIMIT = RACES_ARG ? parseInt(RACES_ARG.split('=')[1]) : pastSessions.length
  const selectedSessions = pastSessions.slice(-RACES_LIMIT)
  console.log(`[Cassandra] Seeding ${selectedSessions.length} races (use --races=N to limit)`)

  for (const session of selectedSessions) {
    try {
    const raceId   = `${session.year}_${session.session_key}`
    const raceName = session.meeting_name
      || session.meeting_official_name
      || session.circuit_short_name
      || session.location
      || `Race ${session.session_key}`
    console.log(`\n  Race: ${raceName}`)

    await client.execute(
      'INSERT INTO ${KS}.race_meta (race_id, race_name, session_key, year) VALUES (?,?,?,?)',
      [raceId, raceName, session.session_key, session.year],
      { prepare: true }
    )

    const drivers = await fetchJSON(`${OPENF1}/drivers?session_key=${session.session_key}`)
    await sleep(300)

    // Store all drivers metadata
    for (const driver of drivers) {
      const driverId = String(driver.driver_number)
      await client.execute(
        'INSERT INTO ${KS}.race_drivers (race_id, driver_id, acronym, full_name, team_name) VALUES (?,?,?,?,?)',
        [raceId, driverId, driver.name_acronym || '', driver.full_name || '', driver.team_name || ''],
        { prepare: true }
      )
    }

    // Fetch real position data for the session (used to map positions to laps)
    process.stdout.write(`    positions feed... `)
    const posByDriver = {}
    try {
      const allPos = await fetchJSON(`${OPENF1}/position?session_key=${session.session_key}`)
      await sleep(300)
      for (const p of allPos) {
        const k = String(p.driver_number)
        if (!posByDriver[k]) posByDriver[k] = []
        posByDriver[k].push({ t: new Date(p.date).getTime(), pos: p.position })
      }
      for (const arr of Object.values(posByDriver)) arr.sort((a, b) => a.t - b.t)
      console.log(`${allPos.length} records ok`)
    } catch (err) {
      console.log(`skipped (${err.message})`)
      await sleep(200)
    }

    // Fetch laps for all drivers
    for (const driver of drivers) {
      const driverId = String(driver.driver_number)
      process.stdout.write(`    ${driver.name_acronym}: laps... `)

      let laps
      try {
        laps = await fetchJSON(
          `${OPENF1}/laps?session_key=${session.session_key}&driver_number=${driver.driver_number}`
        )
      } catch (err) {
        console.log(`skipped (${err.message})`)
        await sleep(200)
        continue
      }
      await sleep(200)

      const driverPosHistory = posByDriver[driverId] || []

      for (const lap of laps) {
        if (!lap.lap_number || !lap.lap_duration) continue

        await client.execute(
          `INSERT INTO ${KS}.lap_times
           (race_id, driver_id, lap_number, lap_time, sector1, sector2, sector3)
           VALUES (?,?,?,?,?,?,?)`,
          [
            raceId, driverId,
            lap.lap_number,
            lap.lap_duration        || 0,
            lap.duration_sector_1   || 0,
            lap.duration_sector_2   || 0,
            lap.duration_sector_3   || 0,
          ],
          { prepare: true }
        )

        // Map real position to this lap using lap end timestamp
        if (lap.date_start && driverPosHistory.length) {
          const lapEndMs = new Date(lap.date_start).getTime() + lap.lap_duration * 1000
          let pos = null
          for (const p of driverPosHistory) {
            if (p.t <= lapEndMs) pos = p.pos
            else break
          }
          if (pos) {
            await client.execute(
              'INSERT INTO ${KS}.race_positions (race_id, driver_id, lap, position) VALUES (?,?,?,?)',
              [raceId, driverId, lap.lap_number, pos],
              { prepare: true }
            )
          }
        }
      }
      console.log(`${laps.length} laps ok`)
    }

    process.stdout.write(`    pit stops... `)
    try {
      const pits = await fetchJSON(`${OPENF1}/pit?session_key=${session.session_key}`)
      await sleep(200)
      const pitsByDriver = {}
      for (const pit of pits) {
        if (!pit.driver_number) continue
        // Skip entries with no duration (OpenF1 sometimes emits phantom pit events)
        if (!pit.pit_duration || pit.pit_duration < 2) continue
        const k = String(pit.driver_number)
        if (!pitsByDriver[k]) pitsByDriver[k] = []
        pitsByDriver[k].push(pit)
      }
      // Deduplicate: remove stops within 2 laps of a previous stop for the same driver
      for (const k of Object.keys(pitsByDriver)) {
        const sorted = pitsByDriver[k].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0))
        pitsByDriver[k] = sorted.filter((pit, i) => {
          if (i === 0) return true
          return (pit.lap_number || 0) - (sorted[i - 1].lap_number || 0) > 2
        })
      }
      let stored = 0
      for (const [driverId, stops] of Object.entries(pitsByDriver)) {
        for (let i = 0; i < stops.length; i++) {
          const pit = stops[i]
          await client.execute(
            `INSERT INTO ${KS}.pit_stops
             (race_id, driver_id, stop_number, lap, duration, time)
             VALUES (?,?,?,?,?,?)`,
            [raceId, driverId, i + 1, pit.lap_number || 0, pit.pit_duration || 0, pit.date || ''],
            { prepare: true }
          )
          stored++
        }
      }
      console.log(`${stored} ok (${pits.length} raw)`)
    } catch (err) {
      console.log(`skipped (${err.message})`)
      await sleep(200)
    }

    process.stdout.write(`    stints... `)
    try {
      const stints = await fetchJSON(`${OPENF1}/stints?session_key=${session.session_key}`)
      await sleep(200)
      for (const stint of stints) {
        if (!stint.driver_number || !stint.stint_number) continue
        await client.execute(
          `INSERT INTO ${KS}.stints
           (race_id, driver_id, stint_number, compound, lap_start, lap_end, tyre_age)
           VALUES (?,?,?,?,?,?,?)`,
          [
            raceId,
            String(stint.driver_number),
            stint.stint_number      || 0,
            stint.compound          || 'UNKNOWN',
            stint.lap_start         || 0,
            stint.lap_end           || 0,
            stint.tyre_age_at_start || 0,
          ],
          { prepare: true }
        )
      }
      console.log(`${stints.length} ok`)
    } catch (err) {
      console.log(`skipped (${err.message})`)
      await sleep(200)
    }

    } catch (err) {
      console.warn(`  [session ${session.session_key}] skipped — ${err.message}`)
      await sleep(500)
    }
  }

  await client.shutdown()
  console.log('\n[Cassandra] Done\n')
}

// ══════════════════════════════════════════════════════════
// DGRAPH  (uses HTTP API — simpler than gRPC for seeding)
// ══════════════════════════════════════════════════════════
async function dgraphHTTP(path, body, contentType = 'application/json') {
  const res = await fetch(`${DGRAPH_HTTP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Dgraph HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function seedDgraph() {
  const ok = await waitForDB('Dgraph', async () => {
    const res = await fetch(`${DGRAPH_HTTP}/health`)
    if (!res.ok) throw new Error('not ready')
  }, 20, 5000)
  if (!ok) return

  // ── Schema ───────────────────────────────────────────
  console.log('[Dgraph] Setting schema...')
  await dgraphHTTP('/alter', `
    driverId:    string @index(exact) .
    name:        string @index(term)  .
    nationality: string @index(hash)  .
    season:      string @index(exact) .
    teamId:      string @index(exact) .
    drives_for:  [uid]  @reverse      .

    type Driver {
      driverId
      name
      nationality
      season
      drives_for
    }
    type Team {
      teamId
      name
    }
  `, 'application/dql')

  // ── Data: build from MongoDB ─────────────────────────
  console.log('[Dgraph] Building graph from MongoDB race results...')
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform')

  const currentYear = String(new Date().getFullYear())
  const races   = await Race.find({ season: currentYear }).select('Results').lean()
  const drivers = await Driver.find().lean()

  // Collect teams and driver→team mappings
  const teamsMap      = new Map() // constructorId → name
  const driverTeamMap = new Map() // driverId → constructorId

  for (const race of races) {
    for (const r of race.Results || []) {
      if (r.Constructor && r.Driver) {
        teamsMap.set(r.Constructor.constructorId, r.Constructor.name)
        driverTeamMap.set(r.Driver.driverId, r.Constructor.constructorId)
      }
    }
  }

  // Build mutation nodes (blank-node pattern)
  const nodes = []

  for (const [teamId, name] of teamsMap) {
    nodes.push({
      uid:           `_:${teamId}`,
      'dgraph.type': 'Team',
      teamId,
      name,
    })
  }

  for (const driver of drivers) {
    const teamId = driverTeamMap.get(driver.driverId)
    const node = {
      uid:           `_:driver_${driver.driverId}`,
      'dgraph.type': 'Driver',
      driverId:      driver.driverId,
      name:          `${driver.givenName} ${driver.familyName}`,
      nationality:   driver.nationality || '',
      season:        currentYear,
    }
    if (teamId) node.drives_for = [{ uid: `_:${teamId}` }]
    nodes.push(node)
  }

  process.stdout.write(`[Dgraph] Mutating ${nodes.length} nodes... `)
  await dgraphHTTP('/mutate?commitNow=true', { set: nodes })
  console.log('ok')

  console.log('[Dgraph] Done\n')
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════')
  console.log('  F1 Platform — Database Initialization')
  console.log('═══════════════════════════════════════\n')

  if (RUN_MONGO)     await seedMongoDB()
  if (RUN_CASSANDRA) await seedCassandra()
  if (RUN_DGRAPH)    await seedDgraph()

  console.log('All done! Restart the backend server.')
  process.exit(0)
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
