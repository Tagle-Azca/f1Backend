import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { connectMongo }    from './src/config/mongodb.js'
import { connectCassandra } from './src/config/cassandra.js'
import { connectDgraph }   from './src/config/dgraph.js'
import routes from './src/routes/index.js'
import { startF1LiveTiming, scheduleConnect } from './src/services/f1LiveTiming.js'

const app  = express()
const PORT = process.env.PORT || 3001

// ── Middleware ───────────────────────────────────────────
app.use(cors({ origin: true }))  // allow all origins in dev
app.use(express.json())

// ── Routes ───────────────────────────────────────────────
app.use('/api', routes)

// ── Health check ─────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }))

// ── Error handler ────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' })
})

// ── Start ────────────────────────────────────────────────
async function start() {
  await connectMongo()
  await connectCassandra()
  await connectDgraph()

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
    startF1LiveTiming()
    refreshF1Schedule()
    // Re-check schedule every 6 hours in case new races are added
    setInterval(refreshF1Schedule, 6 * 60 * 60_000)
  })
}

// ── F1 schedule refresh ──────────────────────────────────
const JOLPICA_SCHEDULE = 'https://api.jolpi.ca/ergast/f1/current.json'

async function refreshF1Schedule() {
  try {
    const res  = await fetch(JOLPICA_SCHEDULE, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const json = await res.json()
    const races = json?.MRData?.RaceTable?.Races || []
    const now   = Date.now()

    const times = []
    for (const r of races) {
      const add = (d, t) => { if (d && t) times.push(`${d}T${t}`) }
      add(r.FirstPractice?.date,  r.FirstPractice?.time)
      add(r.SecondPractice?.date, r.SecondPractice?.time)
      add(r.ThirdPractice?.date,  r.ThirdPractice?.time)
      add(r.SprintShootout?.date, r.SprintShootout?.time)
      add(r.Sprint?.date,         r.Sprint?.time)
      add(r.Qualifying?.date,     r.Qualifying?.time)
      add(r.date,                 r.time)
    }

    const next = times
      .map(t => new Date(t))
      .filter(d => !isNaN(d) && d.getTime() > now)
      .sort((a, b) => a - b)[0]

    if (next) {
      scheduleConnect(next.toISOString())
    } else {
      console.log('[F1Schedule] no upcoming sessions found for this season')
    }
  } catch (e) {
    console.warn('[F1Schedule] failed to fetch schedule:', e.message)
  }
}

start().catch(console.error)

// Prevent any stray unhandled promise / exception from killing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled rejection at:', promise, 'reason:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.stack || err.message)
  // Fatal startup errors must still exit — otherwise nodemon restart loop
  if (err.code === 'EADDRINUSE') process.exit(1)
})
process.on('exit', (code) => {
  if (code !== 0) console.error('[Process] exit with code', code)
})
// Ignore SIGPIPE (broken pipe from WebSocket) — default behavior kills the process on some systems
process.on('SIGPIPE', () => {})
