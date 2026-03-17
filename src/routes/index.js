import { Router } from 'express'
import driversRouter    from './drivers.js'
import circuitsRouter   from './circuits.js'
import racesRouter      from './races.js'
import telemetryRouter  from './telemetry.js'
import graphRouter      from './graph.js'
import searchRouter     from './search.js'
import statsRouter      from './stats.js'
import dashboardRouter  from './dashboard.js'

const router = Router()

// MongoDB routes
router.use('/drivers',   driversRouter)
router.use('/circuits',  circuitsRouter)
router.use('/races',     racesRouter)
router.use('/search',    searchRouter)
router.use('/stats',     statsRouter)
router.use('/dashboard', dashboardRouter)

// Cassandra routes
router.use('/telemetry', telemetryRouter)

// Dgraph routes
router.use('/graph',     graphRouter)

export default router
