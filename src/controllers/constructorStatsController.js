import * as constructorStatsService from '../services/constructorStatsService.js'

export async function getCircuitHistory(req, res, next) {
  try {
    const data = await constructorStatsService.getCircuitHistoryData(req.params.id)
    if (!data) return res.status(404).json({ message: 'Circuit not found' })
    res.json(data)
  } catch (err) { next(err) }
}

export async function getConstructorStats(req, res, next) {
  try {
    const data = await constructorStatsService.getConstructorStatsData(req.params.id)
    if (!data) return res.status(404).json({ message: 'Constructor not found' })
    res.json(data)
  } catch (err) { next(err) }
}
