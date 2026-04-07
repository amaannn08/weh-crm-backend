import express from 'express'
import { sql } from '../db/neon.js'

const router = express.Router()

router.get('/', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT
        dm.id,
        dm.deal_id,
        dm.meeting_date,
        d.company,
        d.sector,
        d.poc,
        d.status,
        d.conviction_score,
        d.exciting_reason,
        d.risks,
        d.pass_reasons,
        d.watch_reasons,
        d.action_required
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

