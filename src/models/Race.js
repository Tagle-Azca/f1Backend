import mongoose from 'mongoose'

const QualiSchema = new mongoose.Schema({
  position:    String,
  Driver:      { driverId: String, givenName: String, familyName: String, nationality: String, permanentNumber: String, code: String },
  Constructor: { constructorId: String, name: String },
  Q1: String, Q2: String, Q3: String,
}, { _id: false })

const ResultSchema = new mongoose.Schema({
  position:   String,
  points:     String,
  Driver:     { driverId: String, givenName: String, familyName: String },
  Constructor:{ constructorId: String, name: String },
  laps:       String,
  grid:       String,
  status:     String,
  Time:       { millis: String, time: String },
  FastestLap: {
    rank:         String,
    lap:          String,
    Time:         { time: String },
    AverageSpeed: { units: String, speed: String },
  },
}, { _id: false })

const RaceSchema = new mongoose.Schema({
  season:    { type: String, required: true },
  round:     { type: String, required: true },
  raceName:  { type: String, required: true },
  date:      { type: String },
  time:      { type: String },
  url:       { type: String },
  Circuit: {
    circuitId:   String,
    circuitName: String,
    Location: { lat: String, long: String, locality: String, country: String },
  },
  Results:                 [ResultSchema],
  SprintResults:           [ResultSchema],
  QualifyingResults:       [QualiSchema],
  SprintQualifyingResults: [QualiSchema],
}, { timestamps: true })

RaceSchema.index({ season: 1, round: 1 }, { unique: true })
RaceSchema.index({ season: 1 })
RaceSchema.index({ 'Circuit.circuitId': 1 })

export default mongoose.model('Race', RaceSchema)
