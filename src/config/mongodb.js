import mongoose from 'mongoose'

export async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform'
  try {
    await mongoose.connect(uri)
    console.log('[MongoDB] Connected:', uri)
  } catch (err) {
    console.error('[MongoDB] Connection error:', err.message)
    // Non-fatal — server starts without Mongo if unavailable
  }
}
