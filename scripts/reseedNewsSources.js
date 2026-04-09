/**
 * Cleans up known-problematic sources/targets, then re-seeds with defaults from seed.js.
 *
 * IMPORTANT:
 * - We no longer delete Entrackr by default (manager parity). If Entrackr is flaky, deactivate it instead.
 * - Tracxn often needs JS/auth; we deactivate those scrape targets by default.
 *
 * Run: node scripts/reseedNewsSources.js
 */
import 'dotenv/config'
import { initSchema } from '../db/neon.js'
import { query } from '../modules/portfolioNews/db.js'
import { seedPortfolioNews } from '../modules/portfolioNews/jobs/seed.js'

await initSchema()

// Deactivate Tracxn scrape targets by default (often blocked / JS required).
const { rowCount: tracxnDeactivated } = await query(
  `UPDATE scrape_targets SET active=FALSE WHERE url LIKE '%tracxn.com%'`
)
console.log(`Deactivated ${tracxnDeactivated} Tracxn scrape target(s)`)

// Keep Mitigata and Entrackr; if needed, deactivate explicitly in DB instead of deleting.

console.log('\nSyncing portfolio news seed (companies + RSS + scrape targets)...')
const result = await seedPortfolioNews()
console.log('Seed result:', JSON.stringify(result, null, 2))

process.exit(0)
