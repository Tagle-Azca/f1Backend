import { getCassandraClient } from '../config/cassandra.js'
import * as telemetry from '../services/telemetryService.js'
import { getF1LivePositions } from '../services/f1LiveTiming.js'
import { getLiveCarData } from '../services/openf1Live.js'

function cassandraUnavailable(res) {
  return res.status(503).json({ message: 'Cassandra not connected. Start Cassandra and seed data first.' })
}

function requiresCassandra(handler) {
  return (req, res, next) => {
    if (!getCassandraClient()) return cassandraUnavailable(res)
    return handler(req, res, next)
  }
}

export async function getAvailableRaces(req, res, next) {
  try { res.json(await telemetry.getAvailableRaces()) } catch (err) { next(err) }
}

export async function getRaceDrivers(req, res, next) {
  try { res.json(await telemetry.getRaceDrivers(req.params.raceId)) } catch (err) { next(err) }
}

export async function getLapTimes(req, res, next) {
  try {
    const { raceId, driverId } = req.params
    res.json(await telemetry.getLapTimes(raceId, driverId))
  } catch (err) { next(err) }
}

export async function getRacePace(req, res, next) {
  try {
    const driverIds = (req.query.drivers || '').split(',').map(d => d.trim()).filter(Boolean)
    if (!driverIds.length) return res.json([])
    res.json(await telemetry.getRacePace(req.params.raceId, driverIds))
  } catch (err) { next(err) }
}

export async function getPitStops(req, res, next) {
  try {
    const { raceId, driverId } = req.params
    res.json(await telemetry.getPitStops(raceId, driverId))
  } catch (err) { next(err) }
}

export async function getRacePositions(req, res, next) {
  try { res.json(await telemetry.getRacePositions(req.params.raceId)) } catch (err) { next(err) }
}

export async function getRaceInfo(req, res, next) {
  try { res.json(await telemetry.getRaceInfo(req.params.raceId)) } catch (err) { next(err) }
}

export async function getSafetyCar(req, res, next) {
  try { res.json(await telemetry.getSafetyCar(req.params.raceId)) } catch (err) { next(err) }
}

export async function getTireStrategy(req, res, next) {
  try { res.json(await telemetry.getTireStrategy(req.params.raceId)) } catch (err) { next(err) }
}

export async function getWinnerStrategy(req, res, next) {
  try {
    const data = await telemetry.getWinnerStrategy(req.params.raceId)
    if (!data) return res.status(404).json({ message: 'Winner strategy not available' })
    res.json(data)
  } catch (err) { next(err) }
}

export async function getTimingTower(req, res, next) {
  try { res.json(await telemetry.getTimingTower()) } catch (err) { next(err) }
}

export async function getCarPositions(req, res, next) {
  try {
    // F1 Live Timing Position.z is the primary source (no auth, lowest latency)
    const f1live = getF1LivePositions()
    if (f1live) return res.json(f1live)

    // Fallback: OpenF1 /location with session_key=latest (no year-based auth needed)
    const { positions } = await getLiveCarData()
    res.json({ positions })
  } catch (err) { next(err) }
}

export async function getCarData(req, res, next) {
  try {
    const data = await getLiveCarData()
    res.json(data)
  } catch (err) { next(err) }
}

export const getTeamPace = requiresCassandra(async (req, res, next) => {
  try {
    const { teamName, year, raceId } = req.query
    if (!teamName || !year) return res.status(400).json({ message: 'teamName and year required' })
    const result = await telemetry.getTeamPace(teamName, year, raceId)
    res.json(result ?? null)
  } catch (err) { next(err) }
})
