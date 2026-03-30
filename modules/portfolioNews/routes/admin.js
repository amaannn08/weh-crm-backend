import { Router } from 'express'
import { authMiddleware } from '../../../middleware/auth.js'
import { query } from '../db.js'
import { runIngest } from '../jobs/ingest.js'
import { ingestRssForCompany } from '../services/rss.js'
import { scrapeForCompany } from '../services/scraper.js'
import { seedPortfolioNews } from '../jobs/seed.js'

const router = Router()

router.use(authMiddleware)

router.post('/seed', async (_req, res) => {
  try {
    const result = await seedPortfolioNews()
    return res.json({
      message: 'Portfolio news seed completed',
      ...result
    })
  } catch (err) {
    console.error('[admin/seed]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/ingest', async (_req, res) => {
  res.json({ message: 'Ingest started', startedAt: new Date().toISOString() })
  runIngest().catch((err) => console.error('[admin/ingest]', err))
})

router.post('/ingest/:slug', async (req, res) => {
  const { rows } = await query('SELECT * FROM companies WHERE slug=$1', [req.params.slug])
  if (!rows.length) return res.status(404).json({ error: 'Company not found' })

  res.json({ message: `Ingest started for ${rows[0].name}`, startedAt: new Date().toISOString() })
  Promise.all([ingestRssForCompany(rows[0]), scrapeForCompany(rows[0])]).catch((err) =>
    console.error('[admin/ingest/:slug]', err)
  )
  return undefined
})

router.get('/sources', async (_req, res) => {
  try {
    const { rows: rss } = await query(`
      SELECT r.*, c.name AS company_name, c.slug AS company_slug
      FROM rss_sources r JOIN companies c ON c.id=r.company_id
      ORDER BY c.name, r.label
    `)
    const { rows: scrape } = await query(`
      SELECT s.*, c.name AS company_name, c.slug AS company_slug
      FROM scrape_targets s JOIN companies c ON c.id=s.company_id
      ORDER BY c.name, s.label
    `)
    return res.json({ rss, scrape })
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/sources/rss', async (req, res) => {
  try {
    const { company_slug: companySlug, feed_url: feedUrl, label } = req.body
    if (!companySlug || !feedUrl) return res.status(400).json({ error: 'company_slug and feed_url required' })

    const { rows: companies } = await query('SELECT id FROM companies WHERE slug=$1', [companySlug])
    if (!companies.length) return res.status(404).json({ error: 'Company not found' })

    const { rows } = await query(
      'INSERT INTO rss_sources (company_id, feed_url, label) VALUES ($1,$2,$3) RETURNING *',
      [companies[0].id, feedUrl, label || null]
    )
    return res.status(201).json(rows[0])
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/sources/rss/:id', async (req, res) => {
  await query('UPDATE rss_sources SET active=FALSE WHERE id=$1', [req.params.id])
  return res.json({ success: true })
})

router.delete('/sources/scrape/:id', async (req, res) => {
  await query('UPDATE scrape_targets SET active=FALSE WHERE id=$1', [req.params.id])
  return res.json({ success: true })
})

router.get('/stats', async (_req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM companies WHERE status='active')                AS active_companies,
        (SELECT COUNT(*) FROM news_items WHERE is_published=TRUE)             AS total_news,
        (SELECT COUNT(*) FROM news_items
          WHERE is_published=TRUE
          AND published_at >= NOW() - INTERVAL '7 days')                      AS news_last_7d,
        (SELECT COUNT(*) FROM rss_sources WHERE active=TRUE)                  AS active_rss_sources,
        (SELECT COUNT(*) FROM scrape_targets WHERE active=TRUE)               AS active_scrape_targets,
        (SELECT MAX(ingested_at) FROM news_items)                              AS last_ingested_at,
        (SELECT COUNT(*) FROM newsletter_issues)                               AS total_newsletters,
        (SELECT COUNT(*) FROM newsletter_issues WHERE status='draft')          AS draft_newsletters,
        (SELECT COUNT(*) FROM newsletter_issues WHERE status='published')      AS published_newsletters
    `)
    return res.json(rows[0])
  } catch {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
