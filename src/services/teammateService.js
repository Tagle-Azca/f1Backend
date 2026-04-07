import Race   from '../models/Race.js'
import Driver from '../models/Driver.js'

const parseQTime = t => {
  if (!t || t === '\\N' || t === 'N/A') return null
  const m = t.match(/^(\d+):(\d+\.\d+)$/)
  if (m) return parseInt(m[1]) * 60 + parseFloat(m[2])
  const s = parseFloat(t)
  return isNaN(s) ? null : s
}

const bestQualiTime = r => parseQTime(r.Q3) ?? parseQTime(r.Q2) ?? parseQTime(r.Q1) ?? null
const fullName      = r => `${r.Driver?.givenName ?? ''} ${r.Driver?.familyName ?? ''}`.trim().toLowerCase()

async function findTeammate(races, driverLower) {
  for (const race of races) {
    const results  = race.Results || []
    const myResult = results.find(r => fullName(r) === driverLower)
    if (!myResult) continue

    const myCtorId = myResult.Constructor?.constructorId
    const mate = results.find(r => r.Constructor?.constructorId === myCtorId && fullName(r) !== driverLower)
    if (mate) {
      return {
        myDriverId:      myResult.Driver?.driverId ?? null,
        teammateName:    `${mate.Driver.givenName} ${mate.Driver.familyName}`,
      }
    }
  }
  return { myDriverId: null, teammateName: null }
}

function computeH2H(races, driverLower, teammateLower) {
  let raceDriver = 0, raceMate = 0, racesCompared = 0
  let qualiDriver = 0, qualiMate = 0, qualiCompared = 0
  let qualiGapSum = 0, qualiGapCount = 0

  for (const race of races) {
    const results  = race.Results || []
    const myRace   = results.find(r => fullName(r) === driverLower)
    const mateRace = results.find(r => fullName(r) === teammateLower)

    if (myRace && mateRace) {
      const myPos = parseInt(myRace.position), matePos = parseInt(mateRace.position)
      if (!isNaN(myPos) && !isNaN(matePos)) {
        racesCompared++
        if (myPos < matePos) raceDriver++; else if (matePos < myPos) raceMate++
      }
    }

    const qResults  = race.QualifyingResults || []
    const myQuali   = qResults.find(r => fullName(r) === driverLower)
    const mateQuali = qResults.find(r => fullName(r) === teammateLower)

    if (myQuali && mateQuali) {
      const myQPos = parseInt(myQuali.position), mateQPos = parseInt(mateQuali.position)
      if (!isNaN(myQPos) && !isNaN(mateQPos)) {
        qualiCompared++
        if (myQPos < mateQPos) qualiDriver++; else if (mateQPos < myQPos) qualiMate++
      }
      const myT = bestQualiTime(myQuali), mateT = bestQualiTime(mateQuali)
      if (myT && mateT) { qualiGapSum += myT - mateT; qualiGapCount++ }
    }
  }

  return {
    racesCompared, qualiCompared,
    race:  racesCompared > 0 ? { driver: raceDriver,  teammate: raceMate  } : null,
    quali: qualiCompared > 0 ? { driver: qualiDriver, teammate: qualiMate } : null,
    avgQualiGapSeconds: qualiGapCount > 0 ? Math.round((qualiGapSum / qualiGapCount) * 1000) / 1000 : null,
  }
}

export async function getTeammateH2H(driver, season) {
  const driverLower = driver.toLowerCase().trim()

  const races = await Race.find({ season })
    .select('round raceName Results QualifyingResults')
    .sort({ round: 1 })
    .lean()

  const { myDriverId, teammateName } = await findTeammate(races, driverLower)

  let driverPhotoUrl = null
  if (myDriverId) {
    const doc = await Driver.findOne({ driverId: myDriverId }).select('photoUrl').lean()
    driverPhotoUrl = doc?.photoUrl ?? null
  }

  if (!teammateName) return { racesCompared: 0, qualiCompared: 0, race: null, quali: null, teammateName: null, driverPhotoUrl }

  const h2h = computeH2H(races, driverLower, teammateName.toLowerCase())

  return { driverName: driver, teammateName, driverPhotoUrl, season, ...h2h }
}
