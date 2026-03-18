import { Router } from 'express'
import {
  getAvailableRaces,
  getRaceDrivers,
  getLapTimes,
  getPitStops,
  getRacePace,
  getTireStrategy,
  getRacePositions,
  getTeamPace,
} from '../controllers/telemetryController.js'

const router = Router()

router.get('/races',                      getAvailableRaces)
router.get('/drivers/:raceId',            getRaceDrivers)
router.get('/laps/:raceId/:driverId',     getLapTimes)
router.get('/pitstops/:raceId/:driverId', getPitStops)
router.get('/pace/:raceId',               getRacePace)
router.get('/strategy/:raceId',           getTireStrategy)
router.get('/positions/:raceId',          getRacePositions)
router.get('/team-pace',                  getTeamPace)

export default router
