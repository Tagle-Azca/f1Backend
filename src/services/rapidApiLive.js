/**
 * RapidAPI "F1 Live Pulse" fallback for live timing.
 *
 * The official F1 SignalR feed and OpenF1 real-time both require auth, so this
 * is the source that works from a hosted backend. A single poller serves every
 * visitor from memory; clients never hit RapidAPI themselves.
 *
 * Enabled only when RAPIDAPI_KEY and RAPIDAPI_HOST are set. The session label
 * comes from the schedule (server.js), because the timing endpoint carries none.
 */

import { parseLapTime } from '../utils/formatters.js'
import logger from '../utils/logger.js'
import { isLiveTimingEnabled } from '../config/liveTiming.js'

const POLL_MS       = Number(process.env.RAPIDAPI_POLL_MS) || 10_000
const INFO_POLL_MS  = Number(process.env.RAPIDAPI_INFO_POLL_MS) || 20_000
const STALE_MS      = 60_000
const TIMEOUT_MS    = 8_000
const RACE_TYPES    = new Set(['Race', 'Sprint'])

let session    = null   // { sessionName, raceName, endsAt }
let latest     = null   // { classification, at }
let info       = null   // { data, at } from /sessionInfo: session name, laps, track status
let timer      = null
let infoTimer  = null
let onUpdate   = null

export function isRapidApiEnabled() {
  return isLiveTimingEnabled() && Boolean(process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST)
}

/** Registers a callback fired after each successful poll (used to push SSE status). */
export function setRapidOnUpdate(fn) { onUpdate = fn }

function titleCase(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s
}

function splitName(full, tla) {
  const parts = String(full || '').trim().split(/\s+/)
  const first = parts[0] || ''
  const last  = parts.slice(1).map(w => (w === w.toUpperCase() ? titleCase(w) : w)).join(' ')
  return { fullName: [first, last].filter(Boolean).join(' ') || tla, lastName: last || tla }
}

function sectorStatus(s) {
  if (!s?.Value) return { value: null, status: null }
  if (s.OverallFastest) return { value: s.Value, status: 'purple' }
  if (s.PersonalFastest) return { value: s.Value, status: 'green' }
  return { value: s.Value, status: 'yellow' }
}

/** Maps the RapidAPI timing `lines` array to the classification shape the Live page reads. */
export function mapTimingLines(lines, isRaceType) {
  if (!Array.isArray(lines)) return []

  const entry = (l) => {
    const d = l.driver || {}
    const tla = d.Tla || String(l.racingNumber || '')
    return {
      driverNum: String(l.racingNumber || d.RacingNumber || ''),
      acronym:   tla,
      ...splitName(d.FullName, tla),
      teamName:  d.TeamName || '',
      teamColor: d.TeamColour ? `#${d.TeamColour}` : null,
      compound:  l.compound ? String(l.compound).toUpperCase() : null,
      throttle:  null,
      brake:     null,
      gear:      null,
      sectors:   [0, 1, 2].map(i => sectorStatus(l.Sectors?.[i])),
    }
  }

  if (isRaceType) {
    return lines
      .filter(l => parseInt(l.position))
      .map(l => {
        const position = parseInt(l.position)
        return {
          ...entry(l),
          position,
          stat:         position === 1 ? 'LEADER' : (l.gapToLeader || l.intervalToPositionAhead || null),
          statLabel:    'gap',
          retired:      Boolean(l.retired),
          inPit:        Boolean(l.inPit),
          lastLap:      l.lastLapTime || null,
          bestLap:      l.bestLapTime || null,
          numberOfLaps: null,
        }
      })
      .sort((a, b) => a.position - b.position)
  }

  const ranked = lines
    .map(l => ({ l, sec: l.bestLapTime ? parseLapTime(l.bestLapTime) : null }))
    .filter(({ sec }) => sec && sec < 300)
    .sort((a, b) => a.sec - b.sec)

  return ranked.map(({ l, sec }, i) => {
    const gap = i === 0 ? null : +(sec - ranked[0].sec).toFixed(3)
    return {
      ...entry(l),
      position:  i + 1,
      stat:      l.bestLapTime,
      statLabel: gap !== null ? `+${gap.toFixed(3)}` : 'fastest',
      lastLap:   l.lastLapTime || null,
      bestLap:   l.bestLapTime,
    }
  })
}

async function rapidGet(path) {
  const resp = await fetch(`https://${process.env.RAPIDAPI_HOST}${path}`, {
    headers: {
      'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': process.env.RAPIDAPI_HOST,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`RapidAPI ${resp.status} ${path}`)
  return resp.json()
}

const liveSessionName = () => (info && Date.now() - info.at <= STALE_MS && info.data.sessionName) || session?.sessionName

async function poll() {
  if (!session || Date.now() > session.endsAt) { stop(); return }
  try {
    const json = await rapidGet(process.env.RAPIDAPI_TIMING_PATH || '/timingData')
    const classification = mapTimingLines(json?.lines, RACE_TYPES.has(liveSessionName()))
    if (classification.length) {
      latest = { classification, at: Date.now() }
      onUpdate?.()
    }
  } catch (err) {
    logger.error(`[RapidAPI] poll failed: ${err.message}`)
  }
}

async function pollInfo() {
  if (!session) return
  try {
    const data = await rapidGet(process.env.RAPIDAPI_INFO_PATH || '/sessionInfo')
    if (data && typeof data === 'object') { info = { data, at: Date.now() }; onUpdate?.() }
  } catch (err) {
    logger.error(`[RapidAPI] session info failed: ${err.message}`)
  }
}

function stop() {
  if (timer)     { clearInterval(timer);     timer = null }
  if (infoTimer) { clearInterval(infoTimer); infoTimer = null }
  session = null
  latest  = null
  info    = null
  onUpdate?.()
}

/**
 * Called by the schedule refresh. Pass the in-progress session, or null when none.
 * Starts polling when a session begins and stops when it ends.
 */
export function setRapidSession(next) {
  if (!isRapidApiEnabled()) return
  if (!next) { if (session) stop(); return }
  const changed = !session || session.sessionName !== next.sessionName || session.raceName !== next.raceName
  session = next
  if (changed) latest = null
  if (!timer) {
    logger.info(`[RapidAPI] polling every ${POLL_MS / 1000}s for ${next.sessionName} — ${next.raceName}`)
    timer     = setInterval(poll, POLL_MS)
    infoTimer = setInterval(pollInfo, INFO_POLL_MS)
    pollInfo().then(poll)
  }
}

/** Same shape as getF1LiveClassification(), or null when there is no fresh data. */
export function getRapidClassification() {
  if (!session || !latest || Date.now() - latest.at > STALE_MS) return null
  const i          = info && Date.now() - info.at <= STALE_MS ? info.data : null
  const sessionName = liveSessionName()
  const isRaceType  = RACE_TYPES.has(sessionName)
  const currentLap  = isRaceType ? (Number(i?.currentLap) || null) : null
  const totalLaps   = isRaceType ? (Number(i?.totalLaps) || null) : null
  return {
    sessionName,
    raceName:       i?.meetingName || session.raceName,
    isRaceType,
    classification: latest.classification,
    trackStatus:    i?.trackStatus || null,
    currentLap,
    totalLaps,
    finished:       Boolean(isRaceType && totalLaps && currentLap >= totalLaps),
  }
}
