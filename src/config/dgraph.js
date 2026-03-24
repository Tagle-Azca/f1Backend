import dgraph from 'dgraph-js'
import grpc from '@grpc/grpc-js'
import logger from '../utils/logger.js'

let dgraphClient = null

export function getDgraphClient() {
  return dgraphClient
}

export async function connectDgraph() {
  const url    = process.env.DGRAPH_URL || 'localhost:9080'
  const apiKey = process.env.DGRAPH_API_KEY
  try {
    let credentials
    if (apiKey) {
      // Dgraph Cloud — TLS + API key auth
      const channelCreds  = grpc.credentials.createSsl()
      const metaCreds     = grpc.credentials.createFromMetadataGenerator((_, cb) => {
        const meta = new grpc.Metadata()
        meta.add('x-auth-token', apiKey)
        cb(null, meta)
      })
      credentials = grpc.credentials.combineChannelCredentials(channelCreds, metaCreds)
    } else {
      credentials = grpc.credentials.createInsecure()
    }
    const stub = new dgraph.DgraphClientStub(url, credentials)
    const client = new dgraph.DgraphClient(stub)
    // Ping: run a trivial read-only query to confirm the connection
    const txn = client.newTxn({ readOnly: true })
    await txn.query('{ q(func: has(dgraph.type), first: 1) { uid } }')
    await txn.discard()
    dgraphClient = client
    logger.info('[Dgraph] Connected: ' + url)
  } catch (err) {
    logger.error('[Dgraph] Connection error: ' + err.message)
    dgraphClient = null
  }
}

export async function dgraphQuery(query, vars = {}) {
  if (!dgraphClient) throw new Error('Dgraph client not connected')
  const txn = dgraphClient.newTxn({ readOnly: true })
  try {
    const res  = await txn.queryWithVars(query, vars)
    return res.getJson()
  } finally {
    await txn.discard()
  }
}

export async function dgraphMutate(setJson) {
  if (!dgraphClient) throw new Error('Dgraph client not connected')
  const txn = dgraphClient.newTxn()
  try {
    const mu = new dgraph.Mutation()
    mu.setSetJson(setJson)
    const res = await txn.mutate(mu)
    await txn.commit()
    return res
  } catch (err) {
    await txn.discard()
    throw err
  }
}
