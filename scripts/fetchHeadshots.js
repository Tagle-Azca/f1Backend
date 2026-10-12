#!/usr/bin/env node
/**
 * Stores official F1 headshots (transparent PNG cut-outs) as Driver.photoUrl,
 * using OpenF1's driver list for the latest session.
 *
 * Matching (first hit wins): permanent number, then 3-letter code, then family name.
 * Only https://media.formula1.com URLs are stored. Existing photos are kept unless --force.
 *
 * Usage:
 *   npm run fetch:headshots            → drivers without a photo
 *   npm run fetch:headshots -- --force → replace existing photos (e.g. Wikipedia ones)
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import Driver   from '../src/models/Driver.js'
import { headshotUrl, matchDriver } from '../src/utils/headshots.js'

const OPENF1 = 'https://api.openf1.org/v1'
const FORCE  = process.argv.includes('--force')

async function main() {
  const res = await fetch(`${OPENF1}/drivers?session_key=latest`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`OpenF1 HTTP ${res.status}`)
  const openf1 = (await res.json()).filter(o => headshotUrl(o.headshot_url))
  console.log(`[Headshots] OpenF1 returned ${openf1.length} drivers with a headshot`)

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/f1_platform')
  const filter = FORCE ? {} : { $or: [{ photoUrl: { $exists: false } }, { photoUrl: null }, { photoUrl: '' }] }
  const docs = await Driver.find(filter).select('driverId permanentNumber code familyName givenName').lean()

  let set = 0
  for (const doc of docs) {
    const hit = matchDriver(doc, openf1)
    if (!hit) continue
    await Driver.updateOne({ _id: doc._id }, { $set: { photoUrl: headshotUrl(hit.headshot_url), photoFetched: true } })
    console.log(`  ✓ ${doc.driverId} ← ${hit.name_acronym}`)
    set++
  }
  console.log(`[Headshots] Done: ${set} updated, ${docs.length - set} without a match in the current grid`)
  await mongoose.disconnect()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(`[Headshots] ${err.message}`); process.exit(1) })
}
