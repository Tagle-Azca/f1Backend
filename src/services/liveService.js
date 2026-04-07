import { getF1LiveClassification, saveSessionSnapshot } from './f1LiveTiming.js'

// 3-second cache so concurrent users don't all hit the live source
let liveCache = null

export function getLiveDashboardData() {
  if (liveCache && Date.now() - liveCache.ts < 3000) return liveCache.data

  const live = getF1LiveClassification()
  if (live?.finished) saveSessionSnapshot()
  if (live) console.log('[Live]', `${live.sessionName} — ${live.raceName}${live.finished ? ' (finished — archiving)' : ''}`)

  if (!live) {
    const data = { isLive: false }
    liveCache = { ts: Date.now(), data }
    return data
  }

  const data = {
    isLive:         !live.finished,
    finished:       live.finished || false,
    sessionName:    live.sessionName,
    raceName:       live.raceName,
    isRaceType:     live.isRaceType,
    top3:           live.classification.slice(0, 5),
    classification: live.classification,
    trackStatus:    live.finished ? null : live.trackStatus,
    currentLap:     live.currentLap,
    totalLaps:      live.totalLaps,
    updatedAt:      new Date().toISOString(),
  }
  liveCache = { ts: Date.now(), data }
  return data
}
