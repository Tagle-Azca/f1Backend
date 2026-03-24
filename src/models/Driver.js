import mongoose from 'mongoose'

const DriverSchema = new mongoose.Schema({
  driverId:       { type: String, required: true, unique: true },
  permanentNumber:{ type: String },
  code:           { type: String },
  givenName:      { type: String, required: true },
  familyName:     { type: String, required: true },
  dateOfBirth:    { type: Date },
  nationality:    { type: String },
  url:            { type: String },
  photoUrl:       { type: String },   // Wikipedia thumbnail
  photoFetched:   { type: Boolean, default: false },
}, { timestamps: true })

DriverSchema.index({ familyName: 1 })
DriverSchema.index({ givenName: 1 })
DriverSchema.index({ nationality: 1 })
DriverSchema.index({ givenName: 'text', familyName: 'text' })

export default mongoose.model('Driver', DriverSchema)
