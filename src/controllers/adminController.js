import * as raceSyncService from '../services/raceSyncService.js'
import logger              from '../utils/logger.js'

function validateToken(req) {
  const token = req.query.token || req.headers['x-admin-token']
  return process.env.ADMIN_SEED_TOKEN && token === process.env.ADMIN_SEED_TOKEN
}

export async function triggerCassandraSeed(req, res) {
  if (!validateToken(req)) return res.status(401).json({ message: 'Unauthorized' })

  const year       = req.query.year  || String(new Date().getFullYear())
  const racesLimit = parseInt(req.query.races || '1')
  const force      = req.query.force === 'true'

  res.json({ message: `Seed started for year=${year} races=${racesLimit}`, note: 'Check server logs for progress' })

  raceSyncService.seedRaceToCassandra(year, racesLimit, force)
    .catch(err => logger.error(`[AdminSeed] Background seed failed: ${err.message}`))
}

export async function syncRaces(req, res) {
  if (!validateToken(req)) return res.status(401).json({ message: 'Unauthorized' })

  const year = req.query.year || String(new Date().getFullYear())

  res.json({ message: `Race sync started for year=${year}`, note: 'Check server logs for progress' })

  raceSyncService.syncRacesForYear(year)
    .catch(err => logger.error(`[SyncRaces] Background sync failed: ${err.message}`))
}
