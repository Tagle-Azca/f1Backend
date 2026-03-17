#!/usr/bin/env node
/**
 * Downloads circuit track layouts (GeoJSON) from bacinger/f1-circuits
 * and stores the coordinates array in each Circuit document.
 *
 * Usage:
 *   node scripts/fetchCircuitLayouts.js           → only missing
 *   node scripts/fetchCircuitLayouts.js --all     → re-fetch all
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import Circuit  from '../src/models/Circuit.js'

const BASE  = 'https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits'
const FORCE = process.argv.includes('--all')

// Maps Jolpica circuitId → bacinger filename (country-year)
const CIRCUIT_MAP = {
  // Current calendar
  bahrain:        'bh-2002',
  jeddah:         'sa-2021',
  albert_park:    'au-1953',
  suzuka:         'jp-1962',
  shanghai:       'cn-2004',
  miami:          'us-2022',
  monaco:         'mc-1929',
  silverstone:    'gb-1948',
  red_bull_ring:  'at-1969',
  hungaroring:    'hu-1986',
  spa:            'be-1925',
  zandvoort:      'nl-1948',
  monza:          'it-1922',
  baku:           'az-2016',
  marina_bay:     'sg-2008',
  americas:       'us-2012',
  rodriguez:      'mx-1962',
  interlagos:     'br-1977',
  vegas:          'us-2023',
  losail:         'qa-2004',
  yas_marina:     'ae-2009',
  villeneuve:     'ca-1978',
  catalunya:      'es-1991',
  ricard:         'fr-1969',
  madrid:         'es-2026',
  // Historical
  imola:          'it-1953',
  nurburgring:    'de-1927',
  hockenheimring: 'de-1932',
  estoril:        'pt-1972',
  portimao:       'pt-2008',
  sochi:          'ru-2014',
  istanbul:       'tr-2005',
  sepang:         'my-1999',
  kyalami:        'za-1961',
  buenos_aires:   'ar-1952',
  zhuhai:         'cn-2004',
  magny_cours:    'fr-1960',
  paul_ricard:    'fr-1969',
  jerez:          null,
  adelaide:       null,
}

async function fetchGeoJSON(code) {
  const res = await fetch(`${BASE}/${code}.geojson`)
  if (!res.ok) return null
  return res.json()
}

function extractCoords(geojson) {
  if (!geojson) return null
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features || []) {
      if (f.geometry?.type === 'LineString') return f.geometry.coordinates
    }
  }
  if (geojson.type === 'Feature' && geojson.geometry?.type === 'LineString') {
    return geojson.geometry.coordinates
  }
  if (geojson.type === 'LineString') return geojson.coordinates
  return null
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform')

  const filter = FORCE ? {} : { trackFetched: { $ne: true } }
  const circuits = await Circuit.find(filter).select('circuitId circuitName').lean()

  const toFetch = circuits.filter(c => CIRCUIT_MAP[c.circuitId] !== undefined)
  console.log(`\nFetching layouts for ${toFetch.length} circuits (${FORCE ? 'force' : 'missing only'})...\n`)

  let ok = 0, skipped = 0, failed = 0

  for (const c of toFetch) {
    const code = CIRCUIT_MAP[c.circuitId]
    if (!code) {
      await Circuit.updateOne({ circuitId: c.circuitId }, { trackFetched: true })
      skipped++
      process.stdout.write(`  ·  ${c.circuitId} — no layout available\n`)
      continue
    }

    const geojson = await fetchGeoJSON(code)
    const coords  = extractCoords(geojson)

    if (coords?.length) {
      await Circuit.updateOne(
        { circuitId: c.circuitId },
        { trackCoords: coords, trackFetched: true }
      )
      ok++
      process.stdout.write(`  ✓  ${c.circuitId} (${code}) — ${coords.length} points\n`)
    } else {
      failed++
      process.stdout.write(`  ✗  ${c.circuitId} (${code}) — fetch failed\n`)
    }

    await new Promise(r => setTimeout(r, 150))
  }

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`  Downloaded: ${ok}`)
  console.log(`  No layout:  ${skipped}`)
  console.log(`  Failed:     ${failed}`)
  console.log(`${'─'.repeat(40)}\n`)
  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
