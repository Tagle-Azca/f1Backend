import { Router } from 'express'
import { listRaces, getRace, getSessionSnapshot } from '../controllers/racesController.js'

const router = Router()

router.get('/',                              listRaces)
router.get('/:season/:round/snapshot',       getSessionSnapshot)
router.get('/:season/:round',                getRace)

export default router
