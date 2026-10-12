import { Router } from 'express'
import rateLimit from 'express-rate-limit'
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

// Stricter limit on credential-guessing endpoints — the global /api/ limiter
// (600 req/15min) is far too loose to slow down password brute-forcing.
const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later.' },
})

router.post('/register',     credentialsLimiter, register)
router.post('/login',        credentialsLimiter, login)
router.post('/google',       credentialsLimiter, googleAuth)
router.post('/refresh',      refresh)
router.post('/logout',       requireAuth, logout)
router.get('/me',            requireAuth, me)
router.patch('/preferences', requireAuth, updatePreferences)

export default router
