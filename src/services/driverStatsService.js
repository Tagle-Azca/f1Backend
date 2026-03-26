import { getCassandraClient, cassandraQuery } from '../config/cassandra.js'

/**
 * Counts races in Cassandra where the driver set the fastest lap.
 * Identifies fastest lap as the minimum valid lap_time across all drivers in a race.
 *
 * @param {string} permanentNumber - Driver's permanent number (e.g. "14" for Alonso)
 * @returns {Promise<number>}
 */
export async function countCassandraFastestLaps(permanentNumber) {
  if (!getCassandraClient() || !permanentNumber) return 0

  try {
    // Races where this driver participated
    const driverRaces = await cassandraQuery(
      'SELECT race_id FROM race_drivers WHERE driver_id = ? ALLOW FILTERING',
      [permanentNumber]
    )
    if (!driverRaces.length) return 0

    let count = 0

    for (const { race_id } of driverRaces) {
      // All lap times for this race (all drivers)
      const allLaps = await cassandraQuery(
        'SELECT driver_id, lap_time FROM lap_times WHERE race_id = ? ALLOW FILTERING',
        [race_id]
      )

      // Exclude SC/invalid laps (< 60s)
      const valid = allLaps.filter(l => l.lap_time > 60)
      if (!valid.length) continue

      // Find the driver with the overall minimum lap_time
      let minTime = Infinity
      let minDriver = null
      for (const l of valid) {
        if (l.lap_time < minTime) {
          minTime = l.lap_time
          minDriver = l.driver_id
        }
      }

      if (minDriver === permanentNumber) count++
    }

    return count
  } catch {
    return 0
  }
}
