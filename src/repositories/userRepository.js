import User from '../models/User.js'

/** Find user by email. Includes passwordHash for auth comparisons. */
export function findByEmail(email) {
  return User.findOne({ email })
}

/** Find user by id. Excludes passwordHash and refreshTokens. */
export function findById(id) {
  return User.findById(id).select('-passwordHash -refreshTokens').lean()
}

/** Find user by Google providerId (sub). */
export function findByGoogleId(googleId) {
  return User.findOne({ provider: 'google', providerId: googleId })
}

/** Find user by a specific refreshToken value in their refreshTokens array. */
export function findByRefreshToken(token) {
  return User.findOne({ refreshTokens: token })
}

/** Create a new user document. */
export function create(data) {
  return User.create(data)
}

/** Generic update by id — returns the updated document. */
export function updateById(id, data) {
  return User.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
}

/** Update only the refreshTokens array for a user. */
export function updateRefreshToken(id, token) {
  return User.findByIdAndUpdate(id, { $set: { refreshTokens: token } }, { new: true })
}

/** Update only the preferences sub-document for a user. */
export function updatePreferences(id, preferences) {
  const updates = {}
  for (const [key, value] of Object.entries(preferences)) {
    updates[`preferences.${key}`] = value
  }
  return User.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true })
}
