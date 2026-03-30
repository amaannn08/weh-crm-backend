/**
 * Clears broken RSS sources (Entrackr 404) and stale Tracxn scrape targets,
 * then re-seeds with working URLs from seed.js.
 *
 * Run: node scripts/reseedNewsSources.js
 */
import 'dotenv/config'
import { initSchema } from '../db/neon.js'
import { query } from '../modules/portfolioNews/db.js'
import { seedPortfolioNews } from '../modules/portfolioNews/jobs/seed.js'

await initSchema()

// Remove Entrackr (dead) and Tracxn (requires JS/auth) sources
const { rowCount: rssDeleted } = await query(
    `DELETE FROM rss_sources WHERE feed_url LIKE '%entrackr.com%'`
)
console.log(`Removed ${rssDeleted} broken Entrackr RSS source(s)`)

const { rowCount: scrapeDeleted } = await query(
    `DELETE FROM scrape_targets WHERE url LIKE '%tracxn.com%' OR url LIKE '%mitigata.com%'`
)
console.log(`Removed ${scrapeDeleted} non-working scrape target(s)`)

// Force re-seed of rss_sources (set count to 0 by deleting all, then seed will repopulate)
// We only touch sources that were broken - add missing ones via seed
console.log('\nRe-seeding RSS sources...')
const result = await seedPortfolioNews()
console.log('Seed result:', JSON.stringify(result, null, 2))

process.exit(0)
