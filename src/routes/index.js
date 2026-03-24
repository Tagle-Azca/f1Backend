import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import driversRouter    from './drivers.js'
import circuitsRouter   from './circuits.js'
import racesRouter      from './races.js'
import telemetryRouter  from './telemetry.js'
import graphRouter      from './graph.js'
import searchRouter     from './search.js'
import statsRouter      from './stats.js'
import dashboardRouter  from './dashboard.js'

const router = Router()

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many search requests, please slow down.' },
})

// MongoDB routes
router.use('/drivers',   driversRouter)
router.use('/circuits',  circuitsRouter)
router.use('/races',     racesRouter)
router.use('/search',    searchLimiter, searchRouter)
router.use('/stats',     statsRouter)
router.use('/dashboard', dashboardRouter)

// Cassandra routes
router.use('/telemetry', telemetryRouter)

// Dgraph routes
router.use('/graph',     graphRouter)

export default router
