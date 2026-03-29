import { Router } from 'express'
import { triggerCassandraSeed } from '../controllers/adminController.js'

const router = Router()

// POST or GET both accepted for convenience
router.get('/seed-cassandra',  triggerCassandraSeed)
router.post('/seed-cassandra', triggerCassandraSeed)

export default router
