import { cassandraQuery } from '../config/cassandra.js'

/** True when raceId is not yet in race_meta → needs live proxy */
export async function isLiveRace(raceId) {
  try {
    const rows = await cassandraQuery(
      'SELECT race_id FROM race_meta WHERE race_id = ?', [raceId])
    return rows.length === 0
  } catch { return false }
}

export async function queryAvailableRaces() {
  return cassandraQuery('SELECT race_id, race_name FROM race_meta LIMIT 200')
}

export async function queryRaceDrivers(raceId) {
  return cassandraQuery(
    'SELECT driver_id, acronym, full_name, team_name FROM race_drivers WHERE race_id = ?',
    [raceId])
}

export async function queryLapTimes(raceId, driverId) {
  return cassandraQuery(
    `SELECT lap_number, lap_time, sector1, sector2, sector3
       FROM lap_times WHERE race_id = ? AND driver_id = ?
       ORDER BY lap_number ASC`,
    [raceId, driverId])
}

export async function queryStints(raceId, driverId) {
  return cassandraQuery(
    'SELECT compound, lap_start, lap_end FROM stints WHERE race_id = ? AND driver_id = ?',
    [raceId, driverId])
}

export async function queryAllStints(raceId) {
  return cassandraQuery(
    `SELECT driver_id, stint_number, compound, lap_start, lap_end, tyre_age
       FROM stints WHERE race_id = ? ALLOW FILTERING`,
    [raceId])
}

export async function queryPitStops(raceId, driverId) {
  return cassandraQuery(
    `SELECT stop_number, lap, duration, time
       FROM pit_stops WHERE race_id = ? AND driver_id = ?
       ORDER BY stop_number ASC`,
    [raceId, driverId])
}

export async function queryPitLaps(raceId, driverId) {
  return cassandraQuery(
    'SELECT lap FROM pit_stops WHERE race_id = ? AND driver_id = ?',
    [raceId, driverId])
}

export async function queryAllPitLaps(raceId) {
  return cassandraQuery(
    'SELECT driver_id, lap FROM pit_stops WHERE race_id = ? ALLOW FILTERING',
    [raceId])
}

export async function queryRacePositions(raceId) {
  return cassandraQuery(
    'SELECT driver_id, lap, position FROM race_positions WHERE race_id = ? ALLOW FILTERING',
    [raceId])
}

export async function queryStintLapEnds(raceId) {
  return cassandraQuery(
    'SELECT lap_end FROM stints WHERE race_id = ? ALLOW FILTERING', [raceId])
}

export async function queryRaceMetaByYear(year) {
  return cassandraQuery(
    'SELECT race_id, race_name FROM race_meta WHERE year = ? ALLOW FILTERING',
    [parseInt(year)])
}
