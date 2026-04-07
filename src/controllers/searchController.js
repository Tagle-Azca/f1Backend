import * as searchService from '../services/searchService.js'

export async function search(req, res, next) {
  try {
    const { q, limit } = req.query
    if (!q || q.trim().length < 2) return res.json([])
    if (q.length > 100) return res.status(400).json({ message: 'Query too long' })
    const { results } = await searchService.search(q, limit)
    res.json(results)
  } catch (err) { next(err) }
}
