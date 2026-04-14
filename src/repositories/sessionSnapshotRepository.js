import SessionSnapshot from '../models/SessionSnapshot.js'

export function findByRaceAndSession(raceName, sessionName) {
  return SessionSnapshot.findOne({ raceName, sessionName })
    .select('-__v -createdAt -updatedAt')
    .lean()
}
