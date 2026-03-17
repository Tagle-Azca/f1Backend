import { Router } from 'express'
import { listRaces, getRace } from '../controllers/racesController.js'

const router = Router()

router.get('/',               listRaces)
router.get('/:season/:round', getRace)

export default router
