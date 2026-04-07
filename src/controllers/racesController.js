import * as racesService from '../services/racesService.js'

export async function listRaces(req, res, next) {
  try {
    const { season } = req.query
    const currentYear = String(new Date().getFullYear())
    if (season) {
      const y = parseInt(season)
      if (isNaN(y) || y < 1950 || y > Number(currentYear)) {
        return res.status(400).json({ message: 'Invalid season' })
      }
    }
    const races = await racesService.listRaces(season)
    res.json(races)
  } catch (err) { next(err) }
}

export async function getRace(req, res, next) {
  try {
    const { season, round } = req.params
    const race = await racesService.getRace(season, round)
    if (!race) return res.status(404).json({ message: 'Race not found' })
    res.json(race)
  } catch (err) { next(err) }
}

export async function getSessionSnapshot(req, res, next) {
  try {
    const { season, round } = req.params
    const { session }       = req.query
    const snapshot = await racesService.getSessionSnapshot(season, round, session)
    res.json(snapshot)
  } catch (err) {
    if (err.message?.startsWith('Invalid session key')) {
      return res.status(400).json({ message: err.message })
    }
    next(err)
  }
}
