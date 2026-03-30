import { Router } from 'express'
import crypto from 'crypto'
import { authMiddleware } from '../../../middleware/auth.js'
import { query } from '../db.js'
import { classifySentiment } from '../services/sentiment.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { fund, sentiment, company, category, limit = 20, offset = 0, sort = 'recent' } = req.query
    const params = []
    const where = ['n.is_published = TRUE']

    if (fund) { params.push(fund); where.push(`c.fund = $${params.length}`) }
    if (sentiment) { params.push(sentiment); where.push(`n.sentiment = $${params.length}`) }
    if (company) { params.push(company); where.push(`c.slug = $${params.length}`) }
    if (category) { params.push(`%${category}%`); where.push(`n.category ILIKE $${params.length}`) }

    const orderBy = sort === 'sentiment' ? 'n.sentiment_score DESC, n.published_at DESC' : 'n.published_at DESC'
    const limitVal = Math.min(parseInt(limit, 10) || 20, 100)
    const offsetVal = parseInt(offset, 10) || 0
    params.push(limitVal, offsetVal)

    const { rows } = await query(
      `
      SELECT
        n.id,
        n.title,
        n.raw_summary        AS summary,
        n.ai_summary,
        n.sentiment,
        n.sentiment_score,
        n.category,
        n.tags,
        n.external_url,
        n.source_type,
        n.source_label,
        n.published_at,
        n.ingested_at,
        c.id    AS company_id,
        c.slug  AS company_slug,
        c.name  AS company_name,
        c.fund,
        c.sector,
        c.stage,
        c.status AS company_status,
        c.logo_initials,
        c.logo_color
      FROM news_items n
      JOIN companies c ON c.id = n.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
      params
    )

    const countParams = params.slice(0, -2)
    const { rows: countRows } = await query(
      `
      SELECT COUNT(*) AS total
      FROM news_items n
      JOIN companies c ON c.id = n.company_id
      WHERE ${where.join(' AND ')}
    `,
      countParams
    )

    return res.json({
      total: parseInt(countRows[0].total, 10),
      limit: limitVal,
      offset: offsetVal,
      items: rows
    })
  } catch (err) {
    console.error('[GET /news]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/summary', async (_req, res) => {
  try {
    const { rows } = await query(
      `
      SELECT
        c.fund,
        n.sentiment,
        COUNT(*) AS count
      FROM news_items n
      JOIN companies c ON c.id = n.company_id
      WHERE n.is_published = TRUE
        AND n.published_at >= NOW() - INTERVAL '90 days'
      GROUP BY c.fund, n.sentiment
      ORDER BY c.fund, n.sentiment
    `
    )

    const summary = {}
    for (const row of rows) {
      if (!summary[row.fund]) summary[row.fund] = {}
      summary[row.fund][row.sentiment] = parseInt(row.count, 10)
    }

    const totals = { positive: 0, negative: 0, neutral: 0, watch: 0 }
    for (const fundCounts of Object.values(summary)) {
      for (const [k, v] of Object.entries(fundCounts)) {
        totals[k] = (totals[k] || 0) + v
      }
    }

    return res.json({ by_fund: summary, totals })
  } catch (err) {
    console.error('[GET /news/summary]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `
      SELECT n.*, c.slug AS company_slug, c.name AS company_name,
             c.fund, c.sector, c.logo_initials, c.logo_color
      FROM news_items n
      JOIN companies c ON c.id = n.company_id
      WHERE n.id = $1 AND n.is_published = TRUE
    `,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    return res.json(rows[0])
  } catch (err) {
    console.error('[GET /news/:id]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { company_slug: companySlug, title, summary, external_url: externalUrl, sentiment, category, tags, published_at: publishedAt } = req.body
    if (!companySlug || !title) return res.status(400).json({ error: 'company_slug and title are required' })

    const { rows: companies } = await query('SELECT id FROM companies WHERE slug=$1', [companySlug])
    if (!companies.length) return res.status(404).json({ error: `Company "${companySlug}" not found` })

    const auto = classifySentiment(title, summary || '')
    const hash = crypto.createHash('sha256').update(`${companies[0].id}::${title.slice(0, 120)}`).digest('hex')

    const { rows } = await query(
      `
      INSERT INTO news_items
        (company_id, source_type, title, raw_summary, external_url,
         sentiment, sentiment_score, category, tags, published_at, dedup_hash)
      VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (dedup_hash) DO NOTHING
      RETURNING *
    `,
      [
        companies[0].id,
        title,
        summary || null,
        externalUrl || null,
        sentiment || auto.sentiment,
        auto.score,
        category || auto.category,
        tags || null,
        publishedAt ? new Date(publishedAt) : new Date(),
        hash
      ]
    )

    if (!rows.length) return res.status(409).json({ error: 'Duplicate — item already exists' })
    return res.status(201).json(rows[0])
  } catch (err) {
    console.error('[POST /news]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { sentiment, category, tags, is_published: isPublished, ai_summary: aiSummary } = req.body
    const updates = []
    const params = []

    if (sentiment !== undefined) { params.push(sentiment); updates.push(`sentiment=$${params.length}`) }
    if (category !== undefined) { params.push(category); updates.push(`category=$${params.length}`) }
    if (tags !== undefined) { params.push(tags); updates.push(`tags=$${params.length}`) }
    if (isPublished !== undefined) { params.push(isPublished); updates.push(`is_published=$${params.length}`) }
    if (aiSummary !== undefined) { params.push(aiSummary); updates.push(`ai_summary=$${params.length}`) }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    params.push(req.params.id)
    const { rows } = await query(
      `UPDATE news_items SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    )

    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    return res.json(rows[0])
  } catch (err) {
    console.error('[PATCH /news/:id]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await query('UPDATE news_items SET is_published=FALSE WHERE id=$1', [req.params.id])
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    return res.json({ success: true })
  } catch (err) {
    console.error('[DELETE /news/:id]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
