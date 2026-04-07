import 'dotenv/config'
import express from 'express'
import { join } from 'path'
import cron from 'node-cron'
import authRoutes from './routes/auth.js'
import assistantRoutes from './routes/assistant.js'
import conversationRoutes from './routes/conversations.js'
import dealsRoutes from './routes/deals.js'
import meetingsRoutes from './routes/meetings.js'
import portfolioNewsRoutes from './modules/portfolioNews/routes/news.js'
import portfolioCompaniesRoutes from './modules/portfolioNews/routes/companies.js'
import portfolioNewslettersRoutes from './modules/portfolioNews/routes/newsletters.js'
import portfolioAdminRoutes from './modules/portfolioNews/routes/admin.js'
import { authMiddleware } from './middleware/auth.js'
import { initSchema } from './db/neon.js'
import { runIngest } from './modules/portfolioNews/jobs/ingest.js'
import { runDriveIngest } from './pipelines/driveIngestion.js'

const app = express()
const PORT = process.env.PORT ?? 3000

initSchema()
  .then(() => console.log('Schema init: OK'))
  .catch((err) => {
    console.error('Schema init error:', err)
  })
app.use(express.json())
app.get('/health', (req, res) => res.status(200).send('ok'));
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN ?? '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

app.use(
  '/uploads/deal-files',
  express.static(join(process.cwd(), 'uploads', 'deal-files'))
)

app.use('/auth', authRoutes)
app.use('/assistant', authMiddleware, assistantRoutes)
app.use('/conversations', authMiddleware, conversationRoutes)
app.use('/deals', authMiddleware, dealsRoutes)
app.use('/meetings', authMiddleware, meetingsRoutes)
app.use('/news', portfolioNewsRoutes)
app.use('/companies', portfolioCompaniesRoutes)
app.use('/newsletters', portfolioNewslettersRoutes)
app.use('/admin', portfolioAdminRoutes)

// Manual trigger: POST /admin/ingest/drive
app.post('/admin/ingest/drive', authMiddleware, async (_req, res) => {
  try {
    const result = await runDriveIngest()
    return res.json(result)
  } catch (err) {
    console.error('[admin] Drive ingest error:', err)
    return res.status(500).json({ error: err.message || 'Drive ingest failed' })
  }
})

// Temp debug: GET /admin/sheet-test
app.get('/admin/sheet-test', authMiddleware, async (_req, res) => {
  try {
    const { sheetQueryTool } = await import('./services/tools/sheetQueryTool.js')
    const result = await sheetQueryTool.execute({ input: { query: 'test', tab: 'Sheet1' } })
    return res.json({ ok: true, preview: result.sheetContext?.slice(0, 500) })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

const newsCronEnabled = process.env.NEWS_INGEST_CRON_ENABLED === 'true'
const ingestCron = process.env.INGEST_CRON || '0 */6 * * *'
if (newsCronEnabled) {
  if (cron.validate(ingestCron)) {
    cron.schedule(ingestCron, () => {
      runIngest().catch((err) => console.error('[cron] Ingest error:', err))
    })
    console.log(`[cron] Portfolio news ingest scheduled: ${ingestCron}`)
  } else {
    console.warn(`[cron] Invalid INGEST_CRON expression: "${ingestCron}" — cron disabled`)
  }
}

const driveIngestEnabled = process.env.DRIVE_INGEST_CRON_ENABLED === 'true'
const driveIngestCron = process.env.DRIVE_INGEST_CRON || '0 */6 * * *'
if (driveIngestEnabled) {
  if (cron.validate(driveIngestCron)) {
    cron.schedule(driveIngestCron, () => {
      runDriveIngest().catch((err) => console.error('[cron] Drive ingest error:', err))
    })
    console.log(`[cron] Drive transcript ingest scheduled: ${driveIngestCron}`)
  } else {
    console.warn(`[cron] Invalid DRIVE_INGEST_CRON expression: "${driveIngestCron}" — cron disabled`)
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
