import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  register,
  login,
  googleAuth,
  refresh,
  logout,
  me,
  updatePreferences,
} from '../controllers/authController.js'

const router = Router()

router.post('/register',     register)
router.post('/login',        login)
router.post('/google',       googleAuth)
router.post('/refresh',      refresh)
router.post('/logout',       requireAuth, logout)
router.get('/me',            requireAuth, me)
router.patch('/preferences', requireAuth, updatePreferences)

export default router
