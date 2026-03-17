import { Router } from 'express'
import { listDrivers, getDriver, getFeaturedDrivers } from '../controllers/driversController.js'

const router = Router()

router.get('/featured', getFeaturedDrivers)
router.get('/',         listDrivers)
router.get('/:id',      getDriver)

export default router
