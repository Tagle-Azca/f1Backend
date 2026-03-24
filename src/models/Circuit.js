import mongoose from 'mongoose'

const CircuitSchema = new mongoose.Schema({
  circuitId:   { type: String, required: true, unique: true },
  circuitName: { type: String, required: true },
  url:         { type: String },
  Location: {
    lat:      { type: String },
    long:     { type: String },
    locality: { type: String },
    country:  { type: String },
  },
  trackCoords:  { type: [[Number]] },   // [[lon, lat], ...] from GeoJSON
  trackFetched: { type: Boolean, default: false },
}, { timestamps: true })

CircuitSchema.index({ circuitName: 1 })
CircuitSchema.index({ 'Location.country': 1 })
CircuitSchema.index({ 'Location.locality': 1 })
CircuitSchema.index({ circuitName: 'text', 'Location.country': 'text', 'Location.locality': 'text' })

export default mongoose.model('Circuit', CircuitSchema)
