import bcrypt from 'bcryptjs'
import { OAuth2Client } from 'google-auth-library'
import User from '../models/User.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } from '../config/jwt.js'

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// Cap stored sessions per user — otherwise a user who never logs out on any
// device grows this array forever.
const MAX_REFRESH_TOKENS_PER_USER = 10

// ── Helpers ────────────────────────────────────────────────────────────────

function issueTokens(user) {
  const payload = { sub: user._id.toString(), email: user.email }
  return {
    accessToken:  signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  }
}

// Refresh tokens are stored hashed — see config/jwt.js#hashToken for why.
function storeRefreshToken(user, refreshToken) {
  user.refreshTokens.push(hashToken(refreshToken))
  if (user.refreshTokens.length > MAX_REFRESH_TOKENS_PER_USER) {
    user.refreshTokens = user.refreshTokens.slice(-MAX_REFRESH_TOKENS_PER_USER)
  }
}

// ── Register ───────────────────────────────────────────────────────────────

export async function register(req, res, next) {
  try {
    const { email, password, displayName, dateOfBirth } = req.body
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' })
    }

    const existing = await User.findOne({ email })
    if (existing) return res.status(409).json({ message: 'Email already in use' })

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await User.create({
      email, passwordHash,
      displayName: displayName || '',
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      provider: 'local',
    })

    const { accessToken, refreshToken } = issueTokens(user)
    storeRefreshToken(user, refreshToken)
    await user.save()

    res.status(201).json({ accessToken, refreshToken, user: user.toSafeObject() })
  } catch (err) { next(err) }
}

// ── Login ──────────────────────────────────────────────────────────────────

export async function login(req, res, next) {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' })
    }

    const user = await User.findOne({ email })
    if (!user) return res.status(401).json({ message: 'Invalid credentials' })
    if (!user.passwordHash) {
      return res.status(401).json({ message: 'This account uses Google sign-in. Please log in with Google.' })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return res.status(401).json({ message: 'Invalid credentials' })

    const { accessToken, refreshToken } = issueTokens(user)
    storeRefreshToken(user, refreshToken)
    await user.save()

    res.json({ accessToken, refreshToken, user: user.toSafeObject() })
  } catch (err) { next(err) }
}

// ── Google OAuth ───────────────────────────────────────────────────────────

export async function googleAuth(req, res, next) {
  try {
    const { idToken } = req.body
    if (!idToken) return res.status(400).json({ message: 'idToken is required' })

    let payload
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      })
      payload = ticket.getPayload()
    } catch {
      return res.status(401).json({ message: 'Invalid Google token' })
    }

    const { sub: providerId, email, name: displayName, picture: avatar } = payload

    let user = await User.findOne({ $or: [{ provider: 'google', providerId }, { email }] })
    if (!user) {
      user = await User.create({ email, provider: 'google', providerId, displayName, avatar })
    } else if (!user.providerId) {
      user.provider   = 'google'
      user.providerId = providerId
      if (!user.avatar) user.avatar = avatar
    }

    const { accessToken, refreshToken } = issueTokens(user)
    storeRefreshToken(user, refreshToken)
    await user.save()

    res.json({ accessToken, refreshToken, user: user.toSafeObject() })
  } catch (err) { next(err) }
}

// ── Refresh ────────────────────────────────────────────────────────────────

export async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) return res.status(400).json({ message: 'refreshToken is required' })

    let decoded
    try {
      decoded = verifyRefreshToken(refreshToken)
    } catch {
      return res.status(401).json({ message: 'Invalid or expired refresh token' })
    }

    const user = await User.findById(decoded.sub)
    if (!user || !user.refreshTokens.includes(hashToken(refreshToken))) {
      return res.status(401).json({ message: 'Refresh token not recognized' })
    }

    // Rotate the refresh token
    user.refreshTokens = user.refreshTokens.filter(t => t !== hashToken(refreshToken))
    const { accessToken, refreshToken: newRefresh } = issueTokens(user)
    storeRefreshToken(user, newRefresh)
    await user.save()

    res.json({ accessToken, refreshToken: newRefresh, user: user.toSafeObject() })
  } catch (err) { next(err) }
}

// ── Logout ─────────────────────────────────────────────────────────────────

export async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body
    if (refreshToken) {
      const user = await User.findById(req.user.sub)
      if (user) {
        user.refreshTokens = user.refreshTokens.filter(t => t !== hashToken(refreshToken))
        await user.save()
      }
    }
    res.json({ message: 'Logged out' })
  } catch (err) { next(err) }
}

// ── Me ─────────────────────────────────────────────────────────────────────

export async function me(req, res, next) {
  try {
    const user = await User.findById(req.user.sub)
    if (!user) return res.status(404).json({ message: 'User not found' })
    res.json(user.toSafeObject())
  } catch (err) { next(err) }
}

// ── Update preferences ─────────────────────────────────────────────────────

export async function updatePreferences(req, res, next) {
  try {
    const allowed = ['favoriteDriver', 'favoriteTeam', 'theme', 'notificationsEnabled', 'timezone', 'language']
    const updates = {}
    for (const key of allowed) {
      if (key in req.body) updates[`preferences.${key}`] = req.body[key]
    }

    const user = await User.findByIdAndUpdate(
      req.user.sub,
      { $set: updates },
      { new: true, runValidators: true }
    )
    if (!user) return res.status(404).json({ message: 'User not found' })
    res.json(user.toSafeObject())
  } catch (err) { next(err) }
}
