import { describe, it, expect } from 'vitest'
import { mapTimingLines } from './rapidApiLive.js'

const line = (over) => ({
  Sectors: [
    { Value: '31.521', PersonalFastest: true, OverallFastest: false },
    { Value: '45.052', PersonalFastest: false, OverallFastest: false },
    { Value: '', PersonalFastest: false, OverallFastest: false },
  ],
  bestLapTime: '1:40.451',
  compound: 'soft',
  driver: { FullName: 'Charles LECLERC', TeamName: 'Ferrari', TeamColour: 'ED1131', Tla: 'LEC' },
  gapToLeader: '',
  intervalToPositionAhead: '+2.400',
  inPit: true,
  lastLapTime: '1:44.987',
  position: '3',
  racingNumber: '16',
  retired: false,
  ...over,
})

describe('mapTimingLines', () => {
  it('returns [] for a missing lines array', () => {
    expect(mapTimingLines(undefined, true)).toEqual([])
  })

  it('maps a race line and sorts by position', () => {
    const out = mapTimingLines([line({ position: '2' }), line({ position: '1', racingNumber: '10' })], true)
    expect(out.map(d => d.position)).toEqual([1, 2])
    expect(out[0].stat).toBe('LEADER')
    expect(out[1].stat).toBe('+2.400')
    expect(out[1]).toMatchObject({
      driverNum: '16', acronym: 'LEC', fullName: 'Charles Leclerc', lastName: 'Leclerc',
      teamColor: '#ED1131', compound: 'SOFT', inPit: true,
    })
    expect(out[1].sectors.map(s => s.status)).toEqual(['green', 'yellow', null])
  })

  it('ranks non-race sessions by best lap and drops drivers without one', () => {
    const out = mapTimingLines([
      line({ bestLapTime: '1:40.451', racingNumber: '16' }),
      line({ bestLapTime: '1:37.625', racingNumber: '10' }),
      line({ bestLapTime: '', racingNumber: '44' }),
    ], false)
    expect(out.map(d => d.driverNum)).toEqual(['10', '16'])
    expect(out[0].statLabel).toBe('fastest')
    expect(out[1].statLabel).toBe('+2.826')
  })
})
