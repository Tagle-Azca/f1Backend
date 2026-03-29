import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { connectMongo }    from './src/config/mongodb.js'
import { connectCassandra } from './src/config/cassandra.js'
import { connectDgraph }   from './src/config/dgraph.js'
import routes from './src/routes/index.js'
import { startF1LiveTiming, scheduleConnect, isF1LiveConnected, isSessionArchived, setOnSessionArchived, setOnFinalSnapshot, getF1LiveClassification } from './src/services/f1LiveTiming.js'
import { setF1LiveStateGetter } from './src/services/openf1Live.js'
import SessionSnapshot from './src/models/SessionSnapshot.js'
import { scheduleAutoSeed } from './src/services/autoSeedService.js'
import logger from './src/utils/logger.js'

const app  = express()
const PORT = process.env.PORT || 3001

// ── Middleware ───────────────────────────────────────────
app.use(cors({ origin: true }))  // allow all origins in dev
app.use(express.json())

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
})
// Polling endpoints need a much higher limit — one client at 3s = 300 req/15min alone
const pollingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
})
app.use('/api/telemetry/timing-tower', pollingLimiter)
app.use('/api/telemetry/car-positions', pollingLimiter)
app.use('/api/telemetry/car-data', pollingLimiter)
app.use('/api/', apiLimiter)

// ── Routes ───────────────────────────────────────────────
app.use('/api', routes)

// ── Health check ─────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }))

// ── Admin: force F1Live reconnect (for schedule mismatches) ──
app.post('/admin/f1live/connect', (_req, res) => {
  scheduleConnect(new Date(Date.now() - 1).toISOString())
  res.json({ ok: true, message: 'F1Live connection triggered' })
})

// ── Error handler ────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error(err)
  const status  = err.status || 500
  const message = err.message || 'Internal server error'
  res.status(status).json({ message, status })
})

// ── Start ────────────────────────────────────────────────
async function start() {
  await connectMongo()
  await connectCassandra()
  await connectDgraph()

  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`)
    startF1LiveTiming()
    setF1LiveStateGetter(getF1LiveClassification)  // lets openf1Live read session state without circular import
    // Persist final snapshot to MongoDB so it survives restarts
    setOnFinalSnapshot(async (snapshot) => {
      try {
        await SessionSnapshot.findOneAndUpdate(
          { raceName: snapshot.raceName, sessionName: snapshot.sessionName },
          { $set: {
            isRaceType:     snapshot.isRaceType     || false,
            classification: snapshot.classification || [],
            trackStatus:    snapshot.trackStatus    || null,
            currentLap:     snapshot.currentLap     || null,
            totalLaps:      snapshot.totalLaps      || null,
            savedAt:        new Date(snapshot.savedAt),
          }},
          { upsert: true, new: true }
        )
        logger.info(`[F1Live] snapshot saved to DB: ${snapshot.sessionName} — ${snapshot.raceName}`)
      } catch (e) {
        logger.error('[F1Live] failed to persist snapshot: ' + e.message)
      }
    })
    // When a session ends, immediately find and schedule the next one
    setOnSessionArchived(refreshF1Schedule)
    refreshF1Schedule()
    // Re-check schedule every hour in case of schedule changes
    setInterval(refreshF1Schedule, 60 * 60_000)
  })
}

// ── F1 schedule refresh ──────────────────────────────────
const JOLPICA_SCHEDULE = 'https://api.jolpi.ca/ergast/f1/current.json'

const SESSION_MAX_MS = 3 * 60 * 60_000  // 3h generous window per session

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

    const allDates = times.map(t => new Date(t)).filter(d => !isNaN(d))

    // Connect now if a session is currently within its window (schedule times can be off)
    const currentlyLive = allDates.find(d => {
      const diff = now - d.getTime()
      return diff >= 0 && diff <= SESSION_MAX_MS
    })

    if (currentlyLive && !isF1LiveConnected() && !isSessionArchived()) {
      logger.info(`[F1Schedule] session in progress (started ${Math.round((now - currentlyLive) / 60000)}min ago) — connecting now`)
      scheduleConnect(new Date(now - 1).toISOString())  // triggers immediate connect
      scheduleAutoSeed(races)
      return
    }

    const next = allDates
      .filter(d => d.getTime() > now)
      .sort((a, b) => a - b)[0]

    if (next) {
      scheduleConnect(next.toISOString())
    } else {
      logger.info('[F1Schedule] no upcoming sessions found for this season')
    }

    scheduleAutoSeed(races)
  } catch (e) {
    logger.warn('[F1Schedule] failed to fetch schedule:', e.message)
  }
}

start().catch(err => logger.error(err))

// Prevent any stray unhandled promise / exception from killing the process
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ promise, reason }, '[Process] Unhandled rejection')
})
process.on('uncaughtException', (err) => {
  logger.error('[Process] Uncaught exception: ' + (err.stack || err.message))
  // Fatal startup errors must still exit — otherwise nodemon restart loop
  if (err.code === 'EADDRINUSE') process.exit(1)
})
process.on('exit', (code) => {
  if (code !== 0) logger.error('[Process] exit with code ' + code)
})
// Ignore SIGPIPE (broken pipe from WebSocket) — default behavior kills the process on some systems
process.on('SIGPIPE', () => {})
