import mongoose from 'mongoose'
import logger from '../utils/logger.js'

export async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform'
  try {
    await mongoose.connect(uri)
    logger.info('[MongoDB] Connected: ' + uri)
  } catch (err) {
    logger.error('[MongoDB] Connection error: ' + err.message)
    // Non-fatal — server starts without Mongo if unavailable
  }
}
