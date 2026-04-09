/**
 * One-off helper to sync portfolio news sources/targets into an existing DB.
 *
 * Run:
 *   node scripts/syncPortfolioNewsSources.js
 */
import 'dotenv/config'
import { initSchema } from '../db/neon.js'
import { query } from '../modules/portfolioNews/db.js'
import { seedPortfolioNews } from '../modules/portfolioNews/jobs/seed.js'

await initSchema()

console.log('[sync] Syncing portfolio news seed (companies + rss_sources + scrape_targets)...')
const result = await seedPortfolioNews()
console.log('[sync] Seed result:', JSON.stringify(result, null, 2))

const [{ rows: activeRss }, { rows: activeScrape }, { rows: companies }] = await Promise.all([
  query('SELECT COUNT(*)::int AS count FROM rss_sources WHERE active=TRUE'),
  query('SELECT COUNT(*)::int AS count FROM scrape_targets WHERE active=TRUE'),
  query("SELECT COUNT(*)::int AS count FROM companies WHERE status != 'written-off'")
])

console.log('[sync] Summary:', {
  companiesToProcess: companies?.[0]?.count ?? null,
  activeRssSources: activeRss?.[0]?.count ?? null,
  activeScrapeTargets: activeScrape?.[0]?.count ?? null
})

process.exit(0)

