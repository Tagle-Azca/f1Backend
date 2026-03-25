import mongoose from 'mongoose'

const preferencesSchema = new mongoose.Schema({
  favoriteDriver: { type: String, default: null },
  favoriteTeam:   { type: String, default: null },
  theme: {
    driverId:  { type: String, default: null },
    teamId:    { type: String, default: null },
    colorMode: { type: String, enum: ['dark', 'light', 'system'], default: 'dark' },
  },
  notificationsEnabled: { type: Boolean, default: false },
  timezone:  { type: String, default: 'UTC' },
  language:  { type: String, default: 'en' },
}, { _id: false })

const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, default: null },   // null for OAuth-only accounts
  provider:     { type: String, enum: ['local', 'google', 'apple'], default: 'local' },
  providerId:   { type: String, default: null },
  displayName:  { type: String, default: '' },
  avatar:       { type: String, default: null },
  preferences:  { type: preferencesSchema, default: () => ({}) },
  // Active refresh tokens (array so multiple devices are supported)
  refreshTokens: [{ type: String }],
}, { timestamps: true })

// Never return passwordHash or refreshTokens to clients
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject()
  delete obj.passwordHash
  delete obj.refreshTokens
  return obj
}

export default mongoose.model('User', userSchema)
