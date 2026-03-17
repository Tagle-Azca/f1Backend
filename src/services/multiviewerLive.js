/**
 * Multiviewer Live Timing Service
 * Fetches real-time F1 data from api.multiviewer.app
 * Returns 404 when no session is active — treated as "not live"
 */

// Multiviewer desktop app exposes live timing locally on port 10101
const BASE    = 'http://localhost:10101/api/v2/live-timing/state'
const HEADERS = { 'User-Agent': 'F1IntelligencePlatform/1.0' }
const TIMEOUT = 6000

async function mvFetch(endpoint) {
  const resp = await fetch(`${BASE}/${endpoint}`, {
    headers: HEADERS,
    signal:  AbortSignal.timeout(TIMEOUT),
  })
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`Multiviewer ${resp.status} /${endpoint}`)
  const json = await resp.json()
  // Multiviewer returns { success: false, error: "..." } when Live Timing isn't open
  if (json?.success === false) return null
  return json
}

function parseLapTime(str) {
  if (!str) return null
  const parts = str.split(':')
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  return parseFloat(str)
}

const RACE_TYPES = new Set(['Race', 'Sprint'])

/**
 * Returns live top-3 data for the dashboard, or null if nothing is live.
 * Shape: { sessionName, raceName, isRaceType, top3, currentLap }
 */
export async function getMultiviewerLive() {
  const sessionInfo = await mvFetch('SessionInfo')
  if (!sessionInfo) return null  // 404 → nothing live

  const [driverList, timingData] = await Promise.all([
    mvFetch('DriverList'),
    mvFetch('TimingData'),
  ])

  if (!driverList || !timingData?.Lines) return null

  const sessionName = sessionInfo.Name || sessionInfo.Type || 'Session'
  const raceName    = sessionInfo.Meeting?.Name || ''
  const isRaceType  = RACE_TYPES.has(sessionName)

  const lines   = timingData.Lines  // keyed by racing number string
  const drivers = driverList        // keyed by racing number string

  if (isRaceType) {
    // ── Race / Sprint: sort by position, show gap to leader ──
    const entries = Object.entries(lines)
      .filter(([, l]) => l.Position && !l.Retired)
      .map(([num, l]) => ({ num, pos: parseInt(l.Position) || 99, line: l }))
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 3)

    const currentLap = entries[0]
      ? parseInt(entries[0].line.NumberOfLaps) || null
      : null

    const top3 = entries.map(({ num, pos, line }) => {
      const d   = drivers[num] || {}
      const gap = pos === 1
        ? 'LEADER'
        : line.GapToLeader || line.IntervalToPositionAhead?.Value || null
      return {
        position:  pos,
        driverNum: num,
        acronym:   d.Tla         || num,
        teamName:  d.TeamName    || '',
        teamColor: d.TeamColour  ? `#${d.TeamColour}` : null,
        stat:      gap,
        statLabel: 'gap',
      }
    })

    return { sessionName, raceName, isRaceType, top3, currentLap }

  } else {
    // ── Qualifying / FP: sort by best lap time ────────────────
    const entries = Object.entries(lines)
      .filter(([, l]) => l.BestLapTime?.Value)
      .map(([num, l]) => ({
        num,
        bestSec: parseLapTime(l.BestLapTime.Value),
        lapStr:  l.BestLapTime.Value,
        line:    l,
      }))
      .filter(e => e.bestSec && e.bestSec < 300)
      .sort((a, b) => a.bestSec - b.bestSec)
      .slice(0, 3)

    if (!entries.length) return null

    const fastestSec = entries[0].bestSec

    const top3 = entries.map(({ num, bestSec, lapStr }, i) => {
      const d   = drivers[num] || {}
      const gap = i === 0 ? null : +(bestSec - fastestSec).toFixed(3)
      return {
        position:  i + 1,
        driverNum: num,
        acronym:   d.Tla        || num,
        teamName:  d.TeamName   || '',
        teamColor: d.TeamColour ? `#${d.TeamColour}` : null,
        stat:      lapStr,
        statLabel: gap !== null ? `+${gap.toFixed(3)}` : 'fastest',
      }
    })

    return { sessionName, raceName, isRaceType, top3, currentLap: null }
  }
}
