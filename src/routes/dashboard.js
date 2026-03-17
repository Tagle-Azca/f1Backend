import { Router } from 'express'
import { getDashboard, getLiveDashboard } from '../controllers/dashboardController.js'

const router = Router()
router.get('/',     getDashboard)
router.get('/live', getLiveDashboard)
export default router
