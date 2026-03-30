import { Router } from 'express'
import { authMiddleware } from '../../../middleware/auth.js'
import { query } from '../db.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { fund, status } = req.query
    const where = []
    const params = []
    if (fund) { params.push(fund); where.push(`fund=$${params.length}`) }
    if (status) { params.push(status); where.push(`status=$${params.length}`) }

    const { rows } = await query(
      `
      SELECT
        c.*,
        COUNT(n.id) FILTER (WHERE n.is_published) AS news_count,
        MAX(n.published_at) AS latest_news_at
      FROM companies c
      LEFT JOIN news_items n ON n.company_id = c.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY c.id
      ORDER BY c.fund, c.name
    `,
      params
    )
    return res.json(rows)
  } catch (err) {
    console.error('[GET /companies]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM companies WHERE slug=$1', [req.params.slug])
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    return res.json(rows[0])
  } catch (err) {
    console.error('[GET /companies/:slug]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { slug, name, fund, sector, stage, status, logo_initials: logoInitials, logo_color: logoColor } = req.body
    if (!slug || !name || !fund) return res.status(400).json({ error: 'slug, name, fund are required' })

    const { rows } = await query(
      `
      INSERT INTO companies (slug,name,fund,sector,stage,status,logo_initials,logo_color)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (slug) DO UPDATE SET
        name=EXCLUDED.name, fund=EXCLUDED.fund, sector=EXCLUDED.sector,
        stage=EXCLUDED.stage, status=EXCLUDED.status,
        logo_initials=EXCLUDED.logo_initials, logo_color=EXCLUDED.logo_color
      RETURNING *
    `,
      [slug, name, fund, sector || null, stage || null, status || 'active', logoInitials || null, logoColor || null]
    )

    return res.status(201).json(rows[0])
  } catch (err) {
    console.error('[POST /companies]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
