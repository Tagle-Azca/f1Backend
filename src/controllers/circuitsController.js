import * as circuitsService from '../services/circuitsService.js'

export async function listCircuits(req, res, next) {
  try {
    const { country, search } = req.query
    const circuits = await circuitsService.listCircuits({ country, search })
    res.json(circuits)
  } catch (err) { next(err) }
}

export async function getCircuit(req, res, next) {
  try {
    const circuit = await circuitsService.getCircuit(req.params.id)
    if (!circuit) return res.status(404).json({ message: 'Circuit not found' })
    res.json(circuit)
  } catch (err) { next(err) }
}
