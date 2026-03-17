import cassandra from 'cassandra-driver'

let client = null

export function getCassandraClient() {
  return client
}

export async function connectCassandra() {
  try {
    client = new cassandra.Client({
      contactPoints: [(process.env.CASSANDRA_HOST || '127.0.0.1') + ':' + (process.env.CASSANDRA_PORT || 9042)],
      localDataCenter: process.env.CASSANDRA_DC || 'datacenter1',
      keyspace: process.env.CASSANDRA_KEYSPACE || 'f1_telemetry',
    })
    await client.connect()
    console.log('[Cassandra] Connected')
  } catch (err) {
    console.error('[Cassandra] Connection error:', err.message)
    client = null
  }
}

export async function cassandraQuery(query, params = []) {
  if (!client) throw new Error('Cassandra client not connected')
  const result = await client.execute(query, params, { prepare: true })
  return result.rows
}
