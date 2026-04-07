import * as dashboardService from '../services/dashboardService.js'
import * as teammateService  from '../services/teammateService.js'
import * as liveService      from '../services/liveService.js'

export async function getDashboard(req, res, next) {
  try {
    res.json(await dashboardService.getDashboardData())
  } catch (err) { next(err) }
}

export async function getTeammateH2H(req, res, next) {
  try {
    const { driver, season } = req.query
    if (!driver || !season) return res.status(400).json({ message: 'driver and season are required' })
    res.json(await teammateService.getTeammateH2H(driver, season))
  } catch (err) { next(err) }
}

export async function getLiveDashboard(req, res, next) {
  try {
    res.json(liveService.getLiveDashboardData())
  } catch (err) { next(err) }
}
