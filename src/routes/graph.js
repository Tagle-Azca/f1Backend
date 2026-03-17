import { Router } from 'express'
import { getDriverNetwork, getDriverNode, getDriverConnections, getDriverEgoGraph, getConstructorEgoGraph } from '../controllers/graphController.js'

const router = Router()

router.get('/drivers',                        getDriverNetwork)
router.get('/constructor/:constructorId',     getConstructorEgoGraph)
router.get('/driver/:driverId/ego',           getDriverEgoGraph)
router.get('/driver/:driverId/connections',   getDriverConnections)
router.get('/driver/:driverId',               getDriverNode)

export default router
