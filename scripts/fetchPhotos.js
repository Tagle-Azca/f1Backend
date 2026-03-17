#!/usr/bin/env node
/**
 * Fetches driver portrait photos from Wikipedia API
 *
 * Strategy (tried in order until a photo is found):
 *   1. REST summary API  (originalimage or thumbnail)
 *   2. pageimages API    (more reliable for some pages)
 *   3. Search: "{name} Formula One driver" → pageimages on best result
 *   4. Search: "{name}" plain → pageimages on best result
 *
 * Usage:
 *   npm run fetch:photos           → drivers missing a photo
 *   npm run fetch:photos -- --all  → re-fetch everyone (force refresh)
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import Driver   from '../src/models/Driver.js'

const HEADERS = {
  'Accept':     'application/json',
  'User-Agent': 'F1IntelligencePlatform/1.0 (educational; contact via github)',
}
const CALL_DELAY = 1500 // ms between every single API call
const DELAY_MS   = 500  // extra ms between drivers (on top of call delays)
const FORCE      = process.argv.includes('--all')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Global rate limiter — enforces minimum gap between ALL API calls
let lastCall = 0
async function wikiGet(url) {
  const now  = Date.now()
  const wait = Math.max(0, CALL_DELAY - (now - lastCall))
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: HEADERS })
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') || '30') * 1000
      process.stdout.write(`\n  ⏳ Rate limited — waiting ${retry / 1000}s...\n`)
      await sleep(retry)
      lastCall = Date.now()
      continue
    }
    return res
  }
  return null
}

// ── Method 1: REST summary API ────────────────────────────────────────────────
async function fetchSummary(title) {
  try {
    const res  = await wikiGet(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    )
    if (!res?.ok) return null
    const data = await res.json()
    return data.originalimage?.source || data.thumbnail?.source || null
  } catch { return null }
}

// ── Method 2: pageimages API ──────────────────────────────────────────────────
async function fetchPageImages(title) {
  try {
    const params = new URLSearchParams({
      action:      'query',
      titles:      title,
      prop:        'pageimages',
      pithumbsize: 500,
      format:      'json',
    })
    const res   = await wikiGet(`https://en.wikipedia.org/w/api.php?${params}`)
    if (!res?.ok) return null
    const data  = await res.json()
    const pages = Object.values(data.query?.pages || {})
    if (!pages.length || pages[0].pageid === -1) return null
    return pages[0]?.thumbnail?.source || null
  } catch { return null }
}

async function photoFromTitle(title) {
  if (!title) return null
  return (await fetchSummary(title)) || (await fetchPageImages(title))
}

// ── Search: returns the title of the best Wikipedia result ───────────────────
async function searchWikiTitle(query) {
  try {
    const params = new URLSearchParams({
      action:   'query',
      list:     'search',
      srsearch: query,
      srlimit:  1,
      format:   'json',
    })
    const res  = await wikiGet(`https://en.wikipedia.org/w/api.php?${params}`)
    if (!res?.ok) return null
    const data = await res.json()
    return data.query?.search?.[0]?.title || null
  } catch { return null }
}

// ── Lookup: URL only (1 call per driver — avoids rate limiting) ───────────────
async function getWikiPhoto(wikiUrl) {
  if (!wikiUrl) return null
  const match = wikiUrl.match(/\/wiki\/(.+)$/)
  if (!match) return null
  const title = decodeURIComponent(match[1])
  const photo = await photoFromTitle(title)
  return photo ? { photo, via: 'url' } : null
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform')

  // Quick connectivity check
  process.stdout.write('\nChecking Wikipedia API... ')
  const testPhoto = await fetchSummary('Lewis_Hamilton')
  if (!testPhoto) {
    console.error('FAILED\n  Could not reach Wikipedia API. Check connectivity.\n')
    process.exit(1)
  }
  console.log('OK\n')

  const filter  = FORCE ? {} : { photoFetched: { $ne: true } }
  const drivers = await Driver.find(filter).sort({ familyName: 1 }).lean()

  const eta = Math.round(drivers.length * DELAY_MS / 60000)
  console.log(`Fetching photos for ${drivers.length} drivers (~${eta} min)...\n`)

  let success = 0, failed = 0

  for (const d of drivers) {
    const name   = `${d.givenName} ${d.familyName}`
    const result = await getWikiPhoto(d.url)

    if (result) {
      await Driver.updateOne({ _id: d._id }, { $set: { photoUrl: result.photo, photoFetched: true } })
      success++
      process.stdout.write(`  ✓  ${name}  (${result.via})\n`)
    } else {
      await Driver.updateOne({ _id: d._id }, { $set: { photoFetched: true }, $unset: { photoUrl: 1 } })
      failed++
      process.stdout.write(`  ✗  ${name}\n`)
    }

    await sleep(DELAY_MS)
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  Photos found:    ${success}`)
  console.log(`  Not found:       ${failed}`)
  console.log(`  Total:           ${drivers.length}`)
  console.log(`${'─'.repeat(50)}\n`)
  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
