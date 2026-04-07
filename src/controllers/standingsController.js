import * as standingsService from '../services/standingsService.js'

export async function getSeasonStandings(req, res, next) {
  try {
    const { season } = req.params
    const result = await standingsService.getSeasonStandings(season)
    res.json(result)
  } catch (err) { next(err) }
}

export async function getConstructorStandings(req, res, next) {
  try {
    const { season } = req.params
    const result = await standingsService.getConstructorStandings(season)
    res.json(result)
  } catch (err) { next(err) }
}

export async function getSeasonDrivers(req, res, next) {
  try {
    const { season } = req.params
    const result = await standingsService.getSeasonDrivers(season)
    res.json(result)
  } catch (err) { next(err) }
}
