import { Router } from 'express'
import { getDashboard, getLiveDashboard, getTeammateH2H } from '../controllers/dashboardController.js'

const router = Router()
router.get('/',     getDashboard)
router.get('/live', getLiveDashboard)
router.get('/h2h',  getTeammateH2H)
export default router
