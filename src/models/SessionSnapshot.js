import mongoose from 'mongoose'

const driverSchema = new mongoose.Schema({
  position:  Number,
  driverNum: String,
  acronym:   String,
  fullName:  String,
  teamName:  String,
  teamColor: String,
  compound:  String,
  bestLap:   String,
  stat:      mongoose.Schema.Types.Mixed,
  statLabel: String,
  sectors:   mongoose.Schema.Types.Mixed,
}, { _id: false })

const schema = new mongoose.Schema({
  raceName:    { type: String, required: true },
  sessionName: { type: String, required: true },
  isRaceType:  Boolean,
  classification: [driverSchema],
  trackStatus: String,
  currentLap:  Number,
  totalLaps:   Number,
  savedAt:     Date,
}, { timestamps: true })

schema.index({ raceName: 1, sessionName: 1 }, { unique: true })

export default mongoose.model('SessionSnapshot', schema)
