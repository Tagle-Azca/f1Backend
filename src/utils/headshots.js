// Helpers for scripts/fetchHeadshots.js (OpenF1 headshots → Driver.photoUrl).

// 3col = 319×319 px, sharp at the ~150 px the dashboard shows them on 2x screens
const SIZE = '3col'

const norm = (s) => (typeof s === 'string' ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim() : '')

/** Headshot URL at the wanted size, or null when it isn't an F1 media https URL. */
export function headshotUrl(raw) {
  if (typeof raw !== 'string') return null
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'media.formula1.com') return null
  url.pathname = url.pathname.replace(/\.transform\/\d+col\//, `.transform/${SIZE}/`)
  return url.toString()
}

/**
 * Finds the OpenF1 entry for a Mongo driver. Numbers and codes are reused across eras
 * (Ricciardo and Verstappen both ran #3), so the surname must always agree; a surname-only
 * match also needs the given name (two Leclercs).
 */
export function matchDriver(doc, openf1) {
  const fam = norm(doc.familyName)
  const num = String(doc.permanentNumber ?? '')
  const sameSurname = (o) => !fam || norm(o.last_name) === fam
  const givenHas = (o) => norm(o.first_name) && norm(doc.givenName).split(/\s+/).includes(norm(o.first_name))
  return openf1.find(o => num && String(o.driver_number) === num && sameSurname(o))
    ?? openf1.find(o => doc.code && o.name_acronym === doc.code && sameSurname(o))
    ?? (fam ? openf1.find(o => norm(o.last_name) === fam && givenHas(o)) : null)
    ?? null
}
