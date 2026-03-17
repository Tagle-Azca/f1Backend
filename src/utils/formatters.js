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
