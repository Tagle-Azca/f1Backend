import { describe, it, expect } from 'vitest'
import { headshotUrl, matchDriver } from './headshots.js'

const F1 = 'https://media.formula1.com/d_driver_fallback_image.png/content/dam/fom-website/drivers/K/ANDANT01_Kimi_Antonelli/andant01.png.transform/1col/image.png'

describe('headshotUrl', () => {
  it('upsizes F1 media URLs to 3col', () => {
    expect(headshotUrl(F1)).toContain('.transform/3col/image.png')
  })
  it('rejects anything that is not https on media.formula1.com', () => {
    expect(headshotUrl(F1.replace('https:', 'http:'))).toBeNull()
    expect(headshotUrl('https://evil.example/x.png')).toBeNull()
    expect(headshotUrl('javascript:alert(1)')).toBeNull()
    expect(headshotUrl(null)).toBeNull()
  })
})

describe('matchDriver', () => {
  const openf1 = [
    { driver_number: 12, name_acronym: 'ANT', first_name: 'Kimi', last_name: 'Antonelli' },
    { driver_number: 27, name_acronym: 'HUL', first_name: 'Nico', last_name: 'Hulkenberg' },
    { driver_number: 1, name_acronym: 'NOR', first_name: 'Lando', last_name: 'Norris' },
    { driver_number: 3, name_acronym: 'VER', first_name: 'Max', last_name: 'Verstappen' },
    { driver_number: 16, name_acronym: 'LEC', first_name: 'Charles', last_name: 'Leclerc' },
  ]
  it('matches by number, then code, then accent-free surname plus given name', () => {
    expect(matchDriver({ permanentNumber: '12', familyName: 'Antonelli' }, openf1).name_acronym).toBe('ANT')
    expect(matchDriver({ permanentNumber: '4', code: 'NOR', familyName: 'Norris' }, openf1).name_acronym).toBe('NOR')
    expect(matchDriver({ familyName: 'Hülkenberg', givenName: 'Nico' }, openf1).name_acronym).toBe('HUL')
  })
  it('never matches a reused number or code to a different driver', () => {
    expect(matchDriver({ permanentNumber: '3', code: 'RIC', familyName: 'Ricciardo', givenName: 'Daniel' }, openf1)).toBeNull()
    expect(matchDriver({ familyName: 'Leclerc', givenName: 'Arthur' }, openf1)).toBeNull()
  })
  it('returns null when nothing matches', () => {
    expect(matchDriver({ permanentNumber: '99', code: 'XXX', familyName: 'Nobody', givenName: 'No' }, openf1)).toBeNull()
  })
})
