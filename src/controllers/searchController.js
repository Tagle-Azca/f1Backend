import Driver  from '../models/Driver.js'
import Circuit from '../models/Circuit.js'
import Race    from '../models/Race.js'

export async function search(req, res, next) {
  try {
    const { q, limit = 12 } = req.query
    if (!q || q.trim().length < 2) return res.json([])
    const lim = Number(limit)

    const regex = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

    const [races, drivers, circuits, constructors] = await Promise.all([
      Race.find({
        $or: [
          { raceName: regex },
          { 'Circuit.circuitName': regex },
          { 'Circuit.Location.locality': regex },
          { 'Circuit.Location.country': regex },
        ],
      })
        .select('season round raceName Circuit date')
        .sort({ season: -1, round: 1 })
        .limit(lim)
        .lean(),
      Driver.find({ $or: [{ givenName: regex }, { familyName: regex }] })
        .select('driverId givenName familyName nationality permanentNumber')
        .limit(Math.ceil(lim / 2))
        .lean(),
      Circuit.find({ $or: [{ circuitName: regex }, { 'Location.country': regex }, { 'Location.locality': regex }] })
        .select('circuitId circuitName Location')
        .limit(4)
        .lean(),
      Race.aggregate([
        { $unwind: '$Results' },
        { $match: { 'Results.Constructor.name': regex } },
        { $group: { _id: '$Results.Constructor.constructorId', name: { $first: '$Results.Constructor.name' } } },
        { $limit: 4 },
      ]),
    ])

    const results = [
      ...races.map((r) => ({
        type:        'race',
        id:          `${r.season}-${r.round}`,
        label:       `${r.season} ${r.raceName}`,
        season:      r.season,
        round:       r.round,
        circuitName: r.Circuit?.circuitName,
        date:        r.date,
      })),
      ...drivers.map((d) => ({
        type:        'driver',
        id:          d.driverId,
        label:       `${d.givenName} ${d.familyName}`,
        nationality: d.nationality,
        number:      d.permanentNumber,
      })),
      ...circuits.map((c) => ({
        type:    'circuit',
        id:      c.circuitId,
        label:   c.circuitName,
        country: c.Location?.country,
        locality:c.Location?.locality,
      })),
      ...constructors.map((c) => ({
        type:  'constructor',
        id:    c._id,
        label: c.name,
      })),
    ]

    res.json(results)
  } catch (err) { next(err) }
}
