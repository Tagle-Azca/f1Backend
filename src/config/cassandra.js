import cassandra from 'cassandra-driver'
import fs from 'fs'
import path from 'path'
import os from 'os'
import logger from '../utils/logger.js'

let client = null

export function getCassandraClient() {
  return client
}

export async function connectCassandra() {
  try {
    // Astra DB (production) — uses secure connect bundle from env
    if (process.env.ASTRA_BUNDLE_B64) {
      const bundlePath = path.join(os.tmpdir(), 'secure-connect.zip')
      fs.writeFileSync(bundlePath, Buffer.from(process.env.ASTRA_BUNDLE_B64, 'base64'))

      client = new cassandra.Client({
        cloud: { secureConnectBundle: bundlePath },
        credentials: {
          username: process.env.ASTRA_CLIENT_ID,
          password: process.env.ASTRA_CLIENT_SECRET,
        },
        keyspace: process.env.CASSANDRA_KEYSPACE || 'f1_telemetry',
      })
    } else {
      // Local Docker Cassandra
      client = new cassandra.Client({
        contactPoints: [(process.env.CASSANDRA_HOST || '127.0.0.1') + ':' + (process.env.CASSANDRA_PORT || 9042)],
        localDataCenter: process.env.CASSANDRA_DC || 'datacenter1',
        keyspace: process.env.CASSANDRA_KEYSPACE || 'f1_telemetry',
      })
    }

    await client.connect()
    logger.info('[Cassandra] Connected')
  } catch (err) {
    logger.error('[Cassandra] Connection error: ' + err.message)
    client = null
  }
}

export async function cassandraQuery(query, params = []) {
  if (!client) throw new Error('Cassandra client not connected')
  const result = await client.execute(query, params, { prepare: true })
  return result.rows
}
