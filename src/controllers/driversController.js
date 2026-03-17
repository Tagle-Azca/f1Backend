import Driver from '../models/Driver.js'

export async function listDrivers(req, res, next) {
  try {
    const { nationality, search, limit = 100, skip = 0 } = req.query
    const filter = {}
    if (nationality) filter.nationality = nationality
    if (search) {
      filter.$or = [
        { givenName:  { $regex: search, $options: 'i' } },
        { familyName: { $regex: search, $options: 'i' } },
      ]
    }
    const drivers = await Driver.find(filter)
      .sort({ familyName: 1 })
      .limit(Number(limit))
      .skip(Number(skip))
      .lean()
    res.json(drivers)
  } catch (err) { next(err) }
}

export async function getDriver(req, res, next) {
  try {
    const driver = await Driver.findOne({ driverId: req.params.id }).lean()
    if (!driver) return res.status(404).json({ message: 'Driver not found' })
    res.json(driver)
  } catch (err) { next(err) }
}

// Returns drivers active in recent seasons with their photos — for the banner
export async function getFeaturedDrivers(req, res, next) {
  try {
    const { seasons = '10', season } = req.query
    const Race = (await import('../models/Race.js')).default

    const filter = season
      ? { season }
      : { season: { $gte: String(new Date().getFullYear() - Number(seasons)) } }

    // When a specific season is requested, also return the constructor for each driver
    if (season) {
      const races = await Race.find({ season })
        .select('Results.Driver.driverId Results.Constructor')
        .lean()

      // Build driver → last known constructor map
      const ctorMap = {}
      for (const race of races) {
        for (const r of race.Results || []) {
          if (r.Driver?.driverId && r.Constructor?.constructorId) {
            ctorMap[r.Driver.driverId] = {
              constructorId: r.Constructor.constructorId,
              constructorName: r.Constructor.name,
            }
          }
        }
      }

      const driverIds = Object.keys(ctorMap)
      const drivers = await Driver.find({ driverId: { $in: driverIds } })
        .select('driverId givenName familyName nationality permanentNumber photoUrl code')
        .lean()

      const result = drivers
        .map(d => ({ ...d, ...(ctorMap[d.driverId] || {}) }))
        .sort((a, b) => a.familyName.localeCompare(b.familyName))

      return res.json(result)
    }

    const recentDriverIds = await Race.distinct('Results.Driver.driverId', filter)
    const drivers = await Driver.find({ driverId: { $in: recentDriverIds } })
      .select('driverId givenName familyName nationality permanentNumber photoUrl code')
      .sort({ familyName: 1 })
      .lean()

    res.json(drivers)
  } catch (err) { next(err) }
}
