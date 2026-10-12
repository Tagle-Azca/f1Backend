/**
 * Build a driver's full name from a driver object (givenName + familyName).
 * Handles missing fields gracefully.
 */
export function buildDriverName(driver) {
  return `${driver?.givenName || ''} ${driver?.familyName || ''}`.trim()
}

/**
 * Round a points value to one decimal place.
 */
export function roundPoints(value) {
  return Math.round((Number(value) || 0) * 10) / 10
}

/**
 * Strip " Grand Prix" suffix from a race name (e.g. "British Grand Prix" → "British GP").
 */
export function normalizeRaceName(name) {
  return (name || '').replace(' Grand Prix', ' GP')
}

/**
 * Escapes regex special characters so user input can be safely used inside `new RegExp(...)`.
 */
export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Format a lap time in seconds to "M:SS.mmm" string.
 * Returns null for falsy input.
 * Example: 92.456 → "1:32.456"
 */
export function fmtLapTime(sec) {
  if (!sec) return null
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(3).padStart(6, '0')
  return `${m}:${s}`
}

/**
 * Parses a lap time string ("M:SS.mmm" or plain seconds) to a number of seconds.
 * Returns null for falsy input. Inverse of fmtLapTime.
 */
export function parseLapTime(str) {
  if (!str) return null
  const parts = str.split(':')
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  return parseFloat(str)
}
