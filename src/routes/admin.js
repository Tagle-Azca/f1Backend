import { Router } from 'express'
import { triggerCassandraSeed, syncRaces } from '../controllers/adminController.js'

const router = Router()

// POST or GET both accepted for convenience
router.get('/seed-cassandra',  triggerCassandraSeed)
router.post('/seed-cassandra', triggerCassandraSeed)

router.get('/sync-races',  syncRaces)
router.post('/sync-races', syncRaces)

export default router
