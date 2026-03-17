import { Router } from 'express'
import { getDriverStats, getDriverCircuits, getDriverSeasons, getHistoricalPerformance } from '../controllers/driverStatsController.js'
import { getSeasonStandings, getConstructorStandings, getSeasonDrivers } from '../controllers/standingsController.js'
import { getCircuitHistory, getConstructorStats } from '../controllers/constructorStatsController.js'

const router = Router()
router.get('/driver/:id',                    getDriverStats)
router.get('/driver/:id/seasons',            getDriverSeasons)
router.get('/driver/:id/circuits',           getDriverCircuits)
router.get('/circuit/:id',                   getCircuitHistory)
router.get('/standings/:season',             getSeasonStandings)
router.get('/constructor-standings/:season', getConstructorStandings)
router.get('/season-drivers/:season',        getSeasonDrivers)
router.get('/historical-performance',        getHistoricalPerformance)
router.get('/constructor/:id',               getConstructorStats)
export default router
