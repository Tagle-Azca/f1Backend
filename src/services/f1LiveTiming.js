/**
 * F1 Live Timing Service
 * Connects directly to livetiming.formula1.com via classic SignalR (v1.5)
 * No local app required — works for all users.
 *
 * Protocol:
 *   1. GET /signalr/negotiate → { ConnectionToken, ... }
 *   2. WebSocket to /signalr/connect?transport=webSockets&connectionToken=...
 *   3. Send subscribe message for topics
 *   4. Parse incoming messages and maintain in-memory state
 */

import WebSocket from 'ws'

const BASE        = 'https://livetiming.formula1.com'
const WS_BASE     = 'wss://livetiming.formula1.com'
const HUB         = 'Streaming'
const TOPICS      = ['SessionInfo', 'DriverList', 'TimingData', 'LapCount', 'TrackStatus']
const RECONNECT_DELAY = 5_000   // ms before reconnect attempt
const MAX_RECONNECTS  = 0       // 0 = unlimited

const HEADERS = {
  'User-Agent':  'F1IntelligencePlatform/1.0',
  'Referer':     'https://www.formula1.com',
  'Origin':      'https://www.formula1.com',
}

const RACE_TYPES = new Set(['Race', 'Sprint'])

// ── In-memory state ─────────────────────────────────────────────────────────
let state = {
  SessionInfo:  null,
  DriverList:   null,
  TimingData:   null,
  LapCount:     null,
  TrackStatus:  null,
}

// Snapshot of the most recently completed session (survives session transitions)
let lastSessionSnapshot = null
// Key of the session we already snapshotted — prevents re-saving on reconnect
let archivedSessionKey  = null

function sessionKey() {
  const s = state.SessionInfo
  if (!s) return null
  return `${s.Meeting?.Name || ''}|${s.Name || s.Type || ''}`
}

/**
 * @param {boolean} final - true only when session actually ends (ws close / session change).
 *   Periodic live snapshots pass false so getF1LiveClassification() keeps returning data.
 */
function saveSnapshot(final = false) {
  const key  = sessionKey()
  if (!key) return
  if (archivedSessionKey === key) return  // already archived

  // For live snapshot: read state directly without going through getF1LiveClassification
  // (which would return null if already archived)
  const { SessionInfo, DriverList, TimingData, LapCount, TrackStatus } = state
  if (!SessionInfo || !DriverList || !TimingData?.Lines) return

  const full = getF1LiveClassification()
  if (!full) return

  const top3data = getF1LiveTop3()
  lastSessionSnapshot = {
    ...full,
    top3: top3data?.top3 || full.classification.slice(0, 5),
    savedAt: new Date().toISOString(),
  }

  if (final) {
    archivedSessionKey = key
    console.log(`[F1Live] snapshot final: ${full.sessionName} — ${full.raceName} (${full.classification.length} drivers)`)
  }
}

let ws           = null
let connected    = false
let reconnecting = false
let reconnectCount = 0
let connectTimer = null   // handle for scheduled future connection

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseLapTime(str) {
  if (!str) return null
  const parts = str.split(':')
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  return parseFloat(str)
}

/**
 * Deep-merge `patch` into `target` (handles nested objects, not arrays).
 * F1 sends partial updates for TimingData.Lines — we need to merge them.
 */
function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object') return patch
  if (!target || typeof target !== 'object') return patch
  const out = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(target[k], v)
  }
  return out
}

// ── SignalR negotiate ─────────────────────────────────────────────────────────
async function negotiate() {
  const url = `${BASE}/signalr/negotiate?` + new URLSearchParams({
    connectionData: JSON.stringify([{ name: HUB }]),
    clientProtocol: '1.5',
  })
  const resp = await fetch(url, {
    headers: HEADERS,
    signal:  AbortSignal.timeout(8000),
  })
  if (!resp.ok) throw new Error(`F1 negotiate ${resp.status}`)
  return resp.json()
}

// SignalR 1.5 requires a /start call after WS opens to confirm the transport
async function signalStart(token) {
  const url = `${BASE}/signalr/start?` + new URLSearchParams({
    transport:       'webSockets',
    connectionToken: token,
    connectionData:  JSON.stringify([{ name: HUB }]),
    clientProtocol:  '1.5',
  })
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(6000) })
    if (!resp.ok) {
      console.warn(`[F1Live] /start returned ${resp.status}`)
      return false
    }
    return true
  } catch (e) {
    console.warn('[F1Live] /start failed:', e.message)
    return false
  }
}

// ── WebSocket connect ────────────────────────────────────────────────────────
function buildWsUrl(token) {
  const tid    = Math.floor(Math.random() * 11)
  const params = new URLSearchParams({
    transport:       'webSockets',
    connectionToken: token,
    connectionData:  JSON.stringify([{ name: HUB }]),
    clientProtocol:  '1.5',
    tid:             String(tid),
  })
  return `${WS_BASE}/signalr/connect?${params}`
}

function handleMessage(raw) {
  let msg
  try { msg = JSON.parse(raw) } catch { return }

  // SignalR heartbeat / keepalive
  if (msg.C) { /* connection token update, ignore */ }

  // Subscribe response — F1 sends the full current state here as msg.R
  if (msg.R && typeof msg.R === 'object') {
    let populated = []
    for (const [topic, data] of Object.entries(msg.R)) {
      if (!data || !TOPICS.includes(topic)) continue
      if (topic === 'TimingData') {
        state.TimingData = deepMerge(state.TimingData || {}, data)
      } else {
        state[topic] = data
      }
      populated.push(topic)
    }
    if (populated.length) console.log('[F1Live] initial state loaded:', populated.join(', '))
  }

  // Data messages from hub
  if (Array.isArray(msg.M)) {
    for (const m of msg.M) {
      if (m.H !== HUB || m.M !== 'feed') continue
      const [topic, data] = m.A || []
      if (!topic) continue

      // Detect session change: archive snapshot before overwriting SessionInfo
      if (topic === 'SessionInfo' && data && state.SessionInfo) {
        const oldName = state.SessionInfo.Name || state.SessionInfo.Type || ''
        const newName = data.Name || data.Type || ''
        if (newName && oldName && newName !== oldName) {
          saveSnapshot(true)  // final — session is ending
        }
      }

      if (topic === 'TimingData' || topic === 'DriverList') {
        // Both send partial patches — deep merge into existing state
        state[topic] = deepMerge(state[topic] || {}, data)
      } else {
        // SessionInfo, LapCount, TrackStatus are replaced wholesale
        state[topic] = data
      }
    }
  }
}

async function connectWs() {
  let negotiateData
  try {
    negotiateData = await negotiate()
  } catch (err) {
    console.error('[F1Live] negotiate failed:', err.message)
    scheduleReconnect()
    return
  }

  const wsUrl = buildWsUrl(negotiateData.ConnectionToken)
  const sock  = new WebSocket(wsUrl, { headers: HEADERS })

  sock.on('open', () => {
    // Wrap entire open logic in an async IIFE so any rejection is caught locally
    ;(async () => {
      connected = true
      reconnectCount = 0
      console.log('[F1Live] connected to livetiming.formula1.com')

      // SignalR 1.5 /start confirmation — retry once with fresh negotiate if it fails
      let startOk = await signalStart(negotiateData.ConnectionToken)
      if (!startOk) {
        console.log('[F1Live] /start failed, re-negotiating...')
        await new Promise(r => setTimeout(r, 2000))
        try {
          const fresh = await negotiate()
          negotiateData = fresh
          startOk = await signalStart(fresh.ConnectionToken)
        } catch (_) {}
        if (!startOk) {
          console.warn('[F1Live] /start still failing — subscribing anyway')
        }
      }

      // Subscribe to topics
      const sub = JSON.stringify({
        H: HUB,
        M: 'Subscribe',
        A: [TOPICS],
        I: 1,
      })
      try { sock.send(sub) } catch (e) {
        console.error('[F1Live] subscribe send error:', e.message)
        return
      }

      // Periodically save a snapshot while a session is active (every 30s)
      const snapshotInterval = setInterval(() => {
        try {
          if (state.SessionInfo && state.TimingData?.Lines) saveSnapshot()
        } catch (e) {
          console.error('[F1Live] snapshot interval error:', e.message)
        }
      }, 30_000)
      sock.once('close', () => clearInterval(snapshotInterval))
    })().catch(e => console.error('[F1Live] open handler error:', e.message))
  })

  sock.on('message', (data) => {
    try { handleMessage(data.toString()) } catch (e) {
      console.error('[F1Live] handleMessage error:', e.message)
    }
  })

  sock.on('close', (code, reason) => {
    connected = false
    try { saveSnapshot(true) } catch (e) { console.error('[F1Live] saveSnapshot error on close:', e.message) }
    state     = { SessionInfo: null, DriverList: null, TimingData: null, LapCount: null, TrackStatus: null }
    console.log(`[F1Live] disconnected (${code})`, reason?.toString() || '')
    scheduleReconnect()
  })

  sock.on('error', (err) => {
    console.error('[F1Live] ws error:', err.message)
    // 'close' will follow
  })

  ws = sock
}

function scheduleReconnect() {
  // If a session was archived, don't loop — wait for scheduleConnect() to fire
  if (archivedSessionKey) {
    console.log('[F1Live] session archived, standing by until next session')
    return
  }
  if (reconnecting) return
  if (MAX_RECONNECTS > 0 && reconnectCount >= MAX_RECONNECTS) return
  reconnecting = true
  reconnectCount++
  setTimeout(() => {
    reconnecting = false
    connectWs().catch(e => console.error('[F1Live] reconnect error:', e.message))
  }, RECONNECT_DELAY)
}

/**
 * Schedule a WebSocket connection 15 minutes before the given ISO session time.
 * Call this from server startup / schedule refresh with the next session datetime.
 */
export function scheduleConnect(isoTime) {
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }

  const msUntil = new Date(isoTime) - Date.now() - 15 * 60_000  // 15 min early

  if (msUntil <= 0) {
    // Session is imminent or already started — connect now
    console.log('[F1Live] session imminent, connecting now')
    if (!connected && !reconnecting) connectWs().catch(e => console.error('[F1Live] connect error:', e.message))
    return
  }

  const eta = new Date(Date.now() + msUntil)
  console.log(`[F1Live] next session ${isoTime} — will connect at ${eta.toISOString()} (${Math.round(msUntil / 60000)}min)`)
  connectTimer = setTimeout(() => {
    connectTimer = null
    archivedSessionKey = null  // allow fresh session
    connectWs().catch(e => console.error('[F1Live] scheduled connect error:', e.message))
  }, msUntil)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once at server start. Connection is managed by scheduleConnect()
 * via refreshF1Schedule() in server.js — do NOT connect unconditionally.
 */
export function startF1LiveTiming() {
  console.log('[F1Live] timing service initialized — waiting for schedule')
}

/**
 * Returns live top-3 data for the dashboard, or null if no active session.
 * Shape: { sessionName, raceName, isRaceType, top3, currentLap }
 */
export function getF1LiveTop3() {
  const { SessionInfo, DriverList, TimingData } = state

  if (!SessionInfo) return null
  if (!DriverList || !TimingData?.Lines) return null

  const sessionName = SessionInfo.Name || SessionInfo.Type || 'Session'
  const raceName    = SessionInfo.Meeting?.Name || SessionInfo.Meeting?.OfficialName || ''
  const isRaceType  = RACE_TYPES.has(sessionName)

  const lines   = TimingData.Lines
  const drivers = DriverList

  function driverEntry(num) {
    const d = drivers[num] || {}
    return {
      driverNum: num,
      acronym:   d.Tla        || num,
      fullName:  [d.FirstName, d.LastName].filter(Boolean).join(' ') || d.Tla || num,
      lastName:  d.LastName   || d.Tla || num,
      teamName:  d.TeamName   || '',
      teamColor: d.TeamColour ? `#${d.TeamColour}` : null,
    }
  }

  if (isRaceType) {
    const entries = Object.entries(lines)
      .filter(([, l]) => l.Position && !l.Retired)
      .map(([num, l]) => ({ num, pos: parseInt(l.Position) || 99, line: l }))
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 5)

    if (!entries.length) return null

    const currentLap = entries[0]
      ? parseInt(entries[0].line.NumberOfLaps) || state.LapCount?.CurrentLap || null
      : null

    const top3 = entries.map(({ num, pos, line }) => {
      const gap = pos === 1
        ? 'LEADER'
        : line.GapToLeader || line.IntervalToPositionAhead?.Value || null
      return {
        ...driverEntry(num),
        position:  pos,
        stat:      gap,
        statLabel: 'gap',
      }
    })

    return { sessionName, raceName, isRaceType, top3, currentLap }

  } else {
    // Qualifying / Practice — sort by best lap time
    const entries = Object.entries(lines)
      .filter(([, l]) => l.BestLapTime?.Value)
      .map(([num, l]) => ({
        num,
        bestSec: parseLapTime(l.BestLapTime.Value),
        lapStr:  l.BestLapTime.Value,
      }))
      .filter(e => e.bestSec && e.bestSec < 300)
      .sort((a, b) => a.bestSec - b.bestSec)
      .slice(0, 5)

    if (!entries.length) return null

    const fastestSec = entries[0].bestSec

    const top3 = entries.map(({ num, bestSec, lapStr }, i) => {
      const gap = i === 0 ? null : +(bestSec - fastestSec).toFixed(3)
      return {
        ...driverEntry(num),
        position:  i + 1,
        stat:      lapStr,
        statLabel: gap !== null ? `+${gap.toFixed(3)}` : 'fastest',
      }
    })

    return { sessionName, raceName, isRaceType, top3, currentLap: null }
  }
}

export function isF1LiveConnected() {
  return connected
}

// Track status code → human label
const TRACK_STATUS_MAP = {
  '1': 'AllClear',
  '2': 'Yellow',
  '3': 'Chequered',
  '4': 'SafetyCar',
  '5': 'Red',
  '6': 'VSC',
  '7': 'SCEnding',
}

/**
 * Returns the full live classification for the /live page.
 * Shape: { sessionName, raceName, isRaceType, classification, trackStatus, currentLap, totalLaps }
 */
export function getF1LiveClassification() {
  const { SessionInfo, DriverList, TimingData, LapCount, TrackStatus } = state

  if (!SessionInfo || !DriverList || !TimingData?.Lines) return null

  // Session already archived (finished + snapshotted) — treat as no active session
  const key = `${SessionInfo.Meeting?.Name || ''}|${SessionInfo.Name || SessionInfo.Type || ''}`
  if (archivedSessionKey === key) return null

  const sessionName = SessionInfo.Name || SessionInfo.Type || 'Session'
  const raceName    = SessionInfo.Meeting?.Name || SessionInfo.Meeting?.OfficialName || ''
  const isRaceType  = RACE_TYPES.has(sessionName)

  const trackStatus = TrackStatus?.Status
    ? (TRACK_STATUS_MAP[String(TrackStatus.Status)] || null)
    : null

  const lines   = TimingData.Lines
  const drivers = DriverList

  function driverEntry(num) {
    const d = drivers[num] || {}
    return {
      driverNum: num,
      acronym:   d.Tla        || num,
      fullName:  [d.FirstName, d.LastName].filter(Boolean).join(' ') || d.Tla || num,
      lastName:  d.LastName   || d.Tla || num,
      teamName:  d.TeamName   || '',
      teamColor: d.TeamColour ? `#${d.TeamColour}` : null,
    }
  }

  // ── Pre-compute best sector times across all drivers (for purple) ──────────
  // F1 sector Status values: 2048=yellow, 2049=green(personal best), 2051=purple(session best)
  const bestSectorTimes = [Infinity, Infinity, Infinity]
  for (const l of Object.values(lines)) {
    const secs = l.Sectors || {}
    for (let i = 0; i < 3; i++) {
      const s = secs[String(i)] || {}
      const t = s.Value ? parseLapTime(s.Value) : null
      if (t && t > 0 && t < 200 && t < bestSectorTimes[i]) bestSectorTimes[i] = t
    }
  }

  function extractSectors(num) {
    const secs = lines[num]?.Sectors || {}
    return [0, 1, 2].map(i => {
      const s     = secs[String(i)] || {}
      const value = s.Value || null
      const t     = value ? parseLapTime(value) : null
      let status  = null
      if (t && t > 0) {
        const isBest = bestSectorTimes[i] !== Infinity && Math.abs(t - bestSectorTimes[i]) < 0.002
        if (isBest || s.Status === 2051) {
          status = 'purple'
        } else if (s.Status === 2049) {
          status = 'green'
        } else {
          status = 'yellow'
        }
      }
      return { value, status }
    })
  }

  let classification = []

  if (isRaceType) {
    classification = Object.entries(lines)
      .filter(([, l]) => l.Position)
      .map(([num, l]) => ({
        ...driverEntry(num),
        position:     parseInt(l.Position) || 99,
        stat:         parseInt(l.Position) === 1
          ? 'LEADER'
          : l.GapToLeader || l.IntervalToPositionAhead?.Value || null,
        statLabel:    'gap',
        retired:      !!(l.Retired || l.Status === 'OUT'),
        inPit:        !!l.InPit,
        lastLap:      l.LastLapTime?.Value || null,
        bestLap:      l.BestLapTime?.Value || null,
        numberOfLaps: parseInt(l.NumberOfLaps) || null,
        sectors:      extractSectors(num),
      }))
      .sort((a, b) => a.position - b.position)
  } else {
    const allEntries = Object.entries(lines)
      .filter(([, l]) => l.BestLapTime?.Value)
      .map(([num, l]) => ({
        num,
        bestSec: parseLapTime(l.BestLapTime.Value),
        lapStr:  l.BestLapTime.Value,
        lastLap: l.LastLapTime?.Value || null,
      }))
      .filter(e => e.bestSec && e.bestSec < 300)
      .sort((a, b) => a.bestSec - b.bestSec)

    const fastestSec = allEntries[0]?.bestSec

    classification = allEntries.map(({ num, bestSec, lapStr, lastLap }, i) => {
      const gap = i === 0 ? null : +(bestSec - fastestSec).toFixed(3)
      return {
        ...driverEntry(num),
        position:  i + 1,
        stat:      lapStr,
        statLabel: gap !== null ? `+${gap.toFixed(3)}` : 'fastest',
        lastLap,
        bestLap:   lapStr,
        sectors:   extractSectors(num),
      }
    })
  }

  const currentLap = isRaceType
    ? (classification[0]?.numberOfLaps || LapCount?.CurrentLap || null)
    : null
  const totalLaps = LapCount?.TotalLaps || null
  const finished  = isRaceType && totalLaps > 0 && currentLap >= totalLaps

  return { sessionName, raceName, isRaceType, classification, trackStatus, currentLap, totalLaps, finished }
}

/**
 * Returns the snapshot of the most recently completed session,
 * useful when Jolpica hasn't published results yet.
 * Shape: { sessionName, raceName, isRaceType, top3, currentLap, savedAt }
 */
export function saveSessionSnapshot() { saveSnapshot() }

export function getLastSessionSnapshot() {
  return lastSessionSnapshot
}
