import * as driverRepository from '../repositories/driverRepository.js'

export async function listDrivers(req, res, next) {
  try {
    const { nationality, search, limit: rawLimit, skip: rawSkip } = req.query
    const limit = Math.min(Math.max(1, parseInt(rawLimit) || 100), 500)
    const skip  = Math.max(0, parseInt(rawSkip) || 0)
    const drivers = await driverRepository.findAll({ nationality, search, skip, limit })
    res.json(drivers)
  } catch (err) { next(err) }
}

export async function getDriver(req, res, next) {
  try {
    const driver = await driverRepository.findById(req.params.id)
    if (!driver) return res.status(404).json({ message: 'Driver not found' })
    res.json(driver)
  } catch (err) { next(err) }
}

export async function getFeaturedDrivers(req, res, next) {
  try {
    const { seasons = '10', season } = req.query
    if (season) {
      const drivers = await driverRepository.findBySeasonWithConstructors(season)
      return res.json(drivers)
    }
    const fromSeason = String(new Date().getFullYear() - Number(seasons))
    const drivers = await driverRepository.findRecentlyActive(fromSeason)
    res.json(drivers)
  } catch (err) { next(err) }
}
