import * as driverStatsService from '../services/driverStatsService.js'

export async function getDriverStats(req, res, next) {
  try {
    const data = await driverStatsService.getDriverStatsData(req.params.id)
    if (!data) return res.status(404).json({ message: 'Driver not found' })
    res.json(data)
  } catch (err) { next(err) }
}

export async function getDriverCircuits(req, res, next) {
  try {
    res.json(await driverStatsService.getDriverCircuitsData(req.params.id))
  } catch (err) { next(err) }
}

export async function getDriverSeasons(req, res, next) {
  try {
    res.json(await driverStatsService.getDriverSeasonsData(req.params.id))
  } catch (err) { next(err) }
}

export async function getDriverNetwork(req, res, next) {
  try {
    const data = await driverStatsService.getDriverNetworkData(req.params.id)
    if (!data) return res.status(404).json({ message: 'Driver not found' })
    res.json(data)
  } catch (err) { next(err) }
}

export async function getHistoricalPerformance(req, res, next) {
  try {
    const { driverId, year } = req.query
    if (!driverId || !year) return res.status(400).json({ message: 'driverId and year are required' })
    res.json(await driverStatsService.getHistoricalPerformanceData(driverId, year))
  } catch (err) { next(err) }
}
