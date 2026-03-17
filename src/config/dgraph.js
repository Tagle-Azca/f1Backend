import dgraph from 'dgraph-js'
import grpc from '@grpc/grpc-js'

let dgraphClient = null

export function getDgraphClient() {
  return dgraphClient
}

export async function connectDgraph() {
  const url = process.env.DGRAPH_URL || 'localhost:9080'
  try {
    const stub = new dgraph.DgraphClientStub(url, grpc.credentials.createInsecure())
    const client = new dgraph.DgraphClient(stub)
    // Ping: run a trivial read-only query to confirm the connection
    const txn = client.newTxn({ readOnly: true })
    await txn.query('{ q(func: has(dgraph.type), first: 1) { uid } }')
    await txn.discard()
    dgraphClient = client
    console.log('[Dgraph] Connected:', url)
  } catch (err) {
    console.error('[Dgraph] Connection error:', err.message)
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
