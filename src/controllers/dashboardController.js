import * as dashboardService from '../services/dashboardService.js'
import * as teammateService  from '../services/teammateService.js'
import * as liveService      from '../services/liveService.js'
import { onLiveStatusChange, getLiveStatusSnapshot } from '../services/f1LiveTiming.js'

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

/**
 * SSE stream — pushes { available, sessionName, raceName, isRaceType } whenever
 * live timing availability changes, so the frontend can enable/disable its
 * "live timing" button without polling.
 */
export function getLiveStatusStream(req, res) {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (status) => res.write(`data: ${JSON.stringify(status)}\n\n`)
  send(getLiveStatusSnapshot())

  const unsubscribe = onLiveStatusChange(send)
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}
