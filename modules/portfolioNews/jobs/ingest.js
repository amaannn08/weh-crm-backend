import { query } from '../db.js'
import { ingestRssForCompany } from '../services/rss.js'
import { scrapeForCompany } from '../services/scraper.js'
import { seedPortfolioNews } from './seed.js'

export async function runIngest() {
  const startTime = Date.now()
  console.log(`[ingest] Starting at ${new Date().toISOString()}`)

  // Ensure seed data exists. This avoids empty `companies` / `rss_sources` / `scrape_targets`
  // after the standalone service is removed.
  const [companiesRows, rssSourcesRows, scrapeTargetsRows] = await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM companies'),
    query('SELECT COUNT(*)::int AS count FROM rss_sources'),
    query('SELECT COUNT(*)::int AS count FROM scrape_targets')
  ])

  const companiesCount = Number(companiesRows?.rows?.[0]?.count ?? 0)
  const rssSourcesCount = Number(rssSourcesRows?.rows?.[0]?.count ?? 0)
  const scrapeTargetsCount = Number(scrapeTargetsRows?.rows?.[0]?.count ?? 0)

  if (companiesCount === 0 || rssSourcesCount === 0 || scrapeTargetsCount === 0) {
    console.log('[ingest] Seed data missing — running portfolio news seed before ingest', {
      companiesCount,
      rssSourcesCount,
      scrapeTargetsCount
    })
    await seedPortfolioNews()
  }

  const { rows: companies } = await query(
    "SELECT * FROM companies WHERE status != 'written-off' ORDER BY fund, name"
  )
  console.log(`[ingest] ${companies.length} companies to process`)

  let totalRss = 0
  let totalScrape = 0
  let errors = 0

  for (const company of companies) {
    try {
      console.log('[ingest] Processing company', {
        id: company.id,
        slug: company.slug,
        name: company.name,
        fund: company.fund,
        status: company.status
      })

      const rssCount = await ingestRssForCompany(company)
      const scrapeCount = await scrapeForCompany(company)

      console.log('[ingest] Company result', {
        slug: company.slug,
        name: company.name,
        rssCount,
        scrapeCount
      })

      totalRss += rssCount
      totalScrape += scrapeCount
      await sleep(1000 + Math.random() * 1000)
    } catch (err) {
      console.error(`[ingest] Error processing ${company.name}:`, err)
      errors += 1
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[ingest] Done in ${duration}s — RSS: +${totalRss}, Scraped: +${totalScrape}, Errors: ${errors}`)
  return { totalRss, totalScrape, errors, durationSec: duration }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
