import express from 'express'
import { sql } from '../db/neon.js'

const router = express.Router()

router.get('/', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT
        dm.*,
        d.company,
        d.sector,
        d.poc
      FROM deal_meetings dm
      JOIN deals d ON dm.deal_id = d.id
      ORDER BY d.created_at DESC
    `
    res.json(rows)
  } catch (err) {
    console.error('Error fetching meetings', err)
    res.status(500).json({ error: 'Failed to fetch meetings' })
  }
})

export default router

