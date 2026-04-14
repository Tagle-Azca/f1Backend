import { getCassandraClient } from '../config/cassandra.js'

const KS  = () => process.env.CASSANDRA_KEYSPACE || 'f1_telemetry'
const run = (q, p) => getCassandraClient().execute(q, p, { prepare: true })

export function isCassandraConnected() {
  return !!getCassandraClient()
}

export function raceExists(raceId) {
  return getCassandraClient()
    .execute(`SELECT race_id FROM ${KS()}.race_meta WHERE race_id = ?`, [raceId], { prepare: true })
    .then(r => r.rowLength > 0)
}

export function insertRaceMeta(raceId, raceName, sessionKey, year) {
  return run(
    `INSERT INTO ${KS()}.race_meta (race_id, race_name, session_key, year) VALUES (?,?,?,?)`,
    [raceId, raceName, sessionKey, year]
  )
}

export function insertDriver(raceId, driverId, acronym, fullName, teamName) {
  return run(
    `INSERT INTO ${KS()}.race_drivers (race_id, driver_id, acronym, full_name, team_name) VALUES (?,?,?,?,?)`,
    [raceId, driverId, acronym, fullName, teamName]
  )
}

export function insertLapTime(raceId, driverId, lapNumber, lapTime, s1, s2, s3) {
  return run(
    `INSERT INTO ${KS()}.lap_times
     (race_id, driver_id, lap_number, lap_time, sector1, sector2, sector3)
     VALUES (?,?,?,?,?,?,?)`,
    [raceId, driverId, lapNumber, lapTime, s1, s2, s3]
  )
}

export function insertRacePosition(raceId, driverId, lap, position) {
  return run(
    `INSERT INTO ${KS()}.race_positions (race_id, driver_id, lap, position) VALUES (?,?,?,?)`,
    [raceId, driverId, lap, position]
  )
}

export function insertPitStop(raceId, driverId, stopNumber, lap, duration, time) {
  return run(
    `INSERT INTO ${KS()}.pit_stops
     (race_id, driver_id, stop_number, lap, duration, time)
     VALUES (?,?,?,?,?,?)`,
    [raceId, driverId, stopNumber, lap, duration, time]
  )
}

export function insertStint(raceId, driverId, stintNumber, compound, lapStart, lapEnd, tyreAge) {
  return run(
    `INSERT INTO ${KS()}.stints
     (race_id, driver_id, stint_number, compound, lap_start, lap_end, tyre_age)
     VALUES (?,?,?,?,?,?,?)`,
    [raceId, driverId, stintNumber, compound, lapStart, lapEnd, tyreAge]
  )
}
