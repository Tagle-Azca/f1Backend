import { Router } from 'express'
import { listCircuits, getCircuit } from '../controllers/circuitsController.js'

const router = Router()

router.get('/',    listCircuits)
router.get('/:id', getCircuit)

export default router
