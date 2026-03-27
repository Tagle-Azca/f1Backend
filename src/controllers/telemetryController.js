import { getCassandraClient } from '../config/cassandra.js'
import * as telemetry from '../services/telemetryService.js'

function cassandraUnavailable(res) {
  return res.status(503).json({ message: 'Cassandra not connected. Start Cassandra and seed data first.' })
}

function requiresCassandra(handler) {
  return (req, res, next) => {
    if (!getCassandraClient()) return cassandraUnavailable(res)
    return handler(req, res, next)
  }
}

export const getAvailableRaces = requiresCassandra(async (req, res, next) => {
  try { res.json(await telemetry.getAvailableRaces()) } catch (err) { next(err) }
})

export const getRaceDrivers = requiresCassandra(async (req, res, next) => {
  try { res.json(await telemetry.getRaceDrivers(req.params.raceId)) } catch (err) { next(err) }
})

export const getLapTimes = requiresCassandra(async (req, res, next) => {
  try {
    const { raceId, driverId } = req.params
    res.json(await telemetry.getLapTimes(raceId, driverId))
  } catch (err) { next(err) }
})

export const getRacePace = requiresCassandra(async (req, res, next) => {
  try {
    const driverIds = (req.query.drivers || '').split(',').map(d => d.trim()).filter(Boolean)
    if (!driverIds.length) return res.json([])
    res.json(await telemetry.getRacePace(req.params.raceId, driverIds))
  } catch (err) { next(err) }
})

export const getPitStops = requiresCassandra(async (req, res, next) => {
  try {
    const { raceId, driverId } = req.params
    res.json(await telemetry.getPitStops(raceId, driverId))
  } catch (err) { next(err) }
})

export const getRacePositions = requiresCassandra(async (req, res, next) => {
  try { res.json(await telemetry.getRacePositions(req.params.raceId)) } catch (err) { next(err) }
})

export const getRaceInfo = requiresCassandra(async (req, res, next) => {
  try { res.json(await telemetry.getRaceInfo(req.params.raceId)) } catch (err) { next(err) }
})

export async function getSafetyCar(req, res, next) {
  try { res.json(await telemetry.getSafetyCar(req.params.raceId)) } catch (err) { next(err) }
}

export const getTireStrategy = requiresCassandra(async (req, res, next) => {
  try { res.json(await telemetry.getTireStrategy(req.params.raceId)) } catch (err) { next(err) }
})

export async function getTimingTower(req, res, next) {
  try { res.json(await telemetry.getTimingTower()) } catch (err) { next(err) }
}

export const getTeamPace = requiresCassandra(async (req, res, next) => {
  try {
    const { teamName, year, raceId } = req.query
    if (!teamName || !year) return res.status(400).json({ message: 'teamName and year required' })
    const result = await telemetry.getTeamPace(teamName, year, raceId)
    res.json(result ?? null)
  } catch (err) { next(err) }
})
