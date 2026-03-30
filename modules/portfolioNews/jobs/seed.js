import { query } from '../db.js'

// Seed data is ported from the original standalone service:
// `weh-portfolio-news/src/db/seed.js`
const COMPANIES = [
  // FUND I
  { slug: 'noto', name: 'NOTO', fund: 'fund1', sector: 'Consumer Food', stage: 'Pre-Series A', status: 'active', logo_initials: 'NT', logo_color: '#FFF0F8' },
  { slug: 'pratilipi', name: 'Pratilipi', fund: 'fund1', sector: 'Content', stage: 'Series A', status: 'active', logo_initials: 'PR', logo_color: '#F0F4FF' },
  { slug: 'clinikk', name: 'Clinikk', fund: 'fund1', sector: 'Health', stage: 'Pre-Series A', status: 'active', logo_initials: 'CL', logo_color: '#F0FAF5' },
  { slug: 'smallcase', name: 'Smallcase', fund: 'fund1', sector: 'WealthTech', stage: 'Series C', status: 'exited', logo_initials: 'SC', logo_color: '#E8F5EE' },
  { slug: 'trell', name: 'Trell', fund: 'fund1', sector: 'Social Commerce', stage: 'Series B', status: 'exited', logo_initials: 'TR', logo_color: '#FFF5F0' },
  { slug: 'animall', name: 'Animall', fund: 'fund1', sector: 'AgriTech', stage: 'Series B', status: 'active', logo_initials: 'AN', logo_color: '#F5F0FF' },

  // FUND II
  { slug: 'masterchow', name: 'Masterchow', fund: 'fund2', sector: 'D2C Food', stage: 'Series A', status: 'active', logo_initials: 'MC', logo_color: '#FFF8E0' },
  { slug: 'unbox-robotics', name: 'Unbox Robotics', fund: 'fund2', sector: 'Robotics', stage: 'Series B', status: 'active', logo_initials: 'UR', logo_color: '#EEF2FA' },
  { slug: 'apps-for-bharat', name: 'Apps for Bharat', fund: 'fund2', sector: 'Consumer Tech', stage: 'Series C', status: 'active', logo_initials: 'AB', logo_color: '#FFF0E8' },
  { slug: 'stellar-play', name: 'Stellar Play', fund: 'fund2', sector: 'Gaming', stage: 'Seed', status: 'active', logo_initials: 'SP', logo_color: '#F0EEFF' },
  { slug: 'jar', name: 'Jar', fund: 'fund2', sector: 'Fintech', stage: 'Series B+', status: 'active', logo_initials: 'JR', logo_color: '#FFF3E0' },
  { slug: 'magma', name: 'Magma (Taozen)', fund: 'fund2', sector: 'B2B SaaS', stage: 'Series A', status: 'active', logo_initials: 'MG', logo_color: '#E8F0FA' },
  { slug: 'infinity-box', name: 'Infinity Box', fund: 'fund2', sector: 'Gaming', stage: 'Post-Seed', status: 'active', logo_initials: 'IB', logo_color: '#FFF5FA' },
  { slug: 'hastin', name: 'Hastin Energy', fund: 'fund2', sector: 'CleanTech', stage: 'Pre-Seed', status: 'active', logo_initials: 'HE', logo_color: '#E8FAF0' },
  { slug: 'simple-viral-games', name: 'Simple Viral Games', fund: 'fund2', sector: 'Gaming', stage: 'Pre-Seed', status: 'active', logo_initials: 'SV', logo_color: '#F5F0FF' },
  { slug: 'hectar', name: 'Hectar', fund: 'fund2', sector: 'AgriTech', stage: 'Seed', status: 'active', logo_initials: 'HC', logo_color: '#F0FAF0' },
  { slug: 'knot', name: 'KNOT (Slick)', fund: 'fund2', sector: 'Consumer Tech', stage: 'Pre-Series A', status: 'active', logo_initials: 'KN', logo_color: '#FFF8F0' },
  { slug: 'sustvest', name: 'Sustvest', fund: 'fund2', sector: 'CleanTech', stage: 'Seed', status: 'active', logo_initials: 'SU', logo_color: '#F0FFF5' },
  { slug: 'game-theory', name: 'Game Theory', fund: 'fund2', sector: 'Gaming/Ed', stage: 'Seed', status: 'active', logo_initials: 'GT', logo_color: '#FFF0F8' },
  { slug: 'mitigata', name: 'Mitigata', fund: 'fund2', sector: 'Cybersecurity', stage: 'Series A', status: 'active', logo_initials: 'MT', logo_color: '#E8EEF8' },
  { slug: 'segmind', name: 'Segmind', fund: 'fund2', sector: 'AI Infra', stage: 'CCD', status: 'active', logo_initials: 'SG', logo_color: '#F0F0FF' },
  { slug: 'flent', name: 'Flent (Slaash)', fund: 'fund2', sector: 'Consumer Tech', stage: 'Pre-Series A', status: 'active', logo_initials: 'FL', logo_color: '#FFF5F0' },
  { slug: 'draconic', name: 'Draconic (Betwizr)', fund: 'fund2', sector: 'Gaming', stage: 'Pre-Seed', status: 'active', logo_initials: 'DR', logo_color: '#F5F0FF' },
  { slug: 'medmitra', name: 'Medmitra', fund: 'fund2', sector: 'Health', stage: 'Seed', status: 'active', logo_initials: 'MM', logo_color: '#F0FFF8' },
  { slug: 'downtown', name: 'Downtown', fund: 'fund2', sector: 'Consumer', stage: 'Seed', status: 'written-off', logo_initials: 'DT', logo_color: '#F5F5F5' },
  { slug: 'zevi', name: 'Zevi', fund: 'fund2', sector: 'E-commerce', stage: 'Seed', status: 'written-off', logo_initials: 'ZV', logo_color: '#F5F5F5' },

  // FUND III
  { slug: 'fragaria', name: 'Fragaria', fund: 'fund3', sector: 'AgriTech', stage: 'Seed', status: 'active', logo_initials: 'FR', logo_color: '#FDEAF2' },
  { slug: 'praan-health', name: 'Praan Health', fund: 'fund3', sector: 'Health', stage: 'Seed', status: 'active', logo_initials: 'PH', logo_color: '#EAF8F0' }
]

const RSS_SOURCES = [
  { slug: 'jar', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }, { url: 'https://startupnews.fyi/feed/', label: 'StartupNews' }] },
  { slug: 'mitigata', feeds: [{ url: 'https://yourstory.com/feed', label: 'YourStory' }, { url: 'https://inc42.com/feed/', label: 'Inc42' }] },
  { slug: 'masterchow', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://startupnews.fyi/feed/', label: 'StartupNews' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'unbox-robotics', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'smallcase', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'fragaria', feeds: [{ url: 'https://startupnews.fyi/feed/', label: 'StartupNews' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'pratilipi', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'animall', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'apps-for-bharat', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'noto', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'segmind', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'mitigata', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }] },
  { slug: 'clinikk', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] },
  { slug: 'hastin', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://startupnews.fyi/feed/', label: 'StartupNews' }] },
  { slug: 'sustvest', feeds: [{ url: 'https://inc42.com/feed/', label: 'Inc42' }, { url: 'https://yourstory.com/feed', label: 'YourStory' }] }
]

// Scrape targets intentionally minimal — sites like Tracxn require JS rendering/auth
// and cannot be scraped with plain HTTP. Add custom targets via POST /admin/sources/rss
const SCRAPE_TARGETS = []

let currentSeedPromise = null

export async function seedPortfolioNews() {
  if (currentSeedPromise) return currentSeedPromise

  currentSeedPromise = (async () => {
    const [companiesRows, rssSourcesRows, scrapeTargetsRows] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM companies'),
      query('SELECT COUNT(*)::int AS count FROM rss_sources'),
      query('SELECT COUNT(*)::int AS count FROM scrape_targets')
    ])

    const companiesCount = Number(companiesRows?.rows?.[0]?.count ?? 0)
    const rssSourcesCount = Number(rssSourcesRows?.rows?.[0]?.count ?? 0)
    const scrapeTargetsCount = Number(scrapeTargetsRows?.rows?.[0]?.count ?? 0)

    const seeded = {
      companies: false,
      rss_sources: false,
      scrape_targets: false
    }

    if (companiesCount === 0) {
      for (const co of COMPANIES) {
        await query(
          `
          INSERT INTO companies (slug, name, fund, sector, stage, status, logo_initials, logo_color)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (slug) DO UPDATE SET
            name=EXCLUDED.name,
            fund=EXCLUDED.fund,
            sector=EXCLUDED.sector,
            stage=EXCLUDED.stage,
            status=EXCLUDED.status,
            logo_initials=EXCLUDED.logo_initials,
            logo_color=EXCLUDED.logo_color
        `,
          [co.slug, co.name, co.fund, co.sector, co.stage, co.status, co.logo_initials, co.logo_color]
        )
      }
      seeded.companies = true
    }

    if (rssSourcesCount === 0) {
      for (const { slug, feeds } of RSS_SOURCES) {
        const { rows: companyRows } = await query('SELECT id FROM companies WHERE slug=$1', [slug])
        const companyId = companyRows?.[0]?.id
        if (!companyId) continue

        for (const feed of feeds) {
          await query(
            `
            INSERT INTO rss_sources (company_id, feed_url, label)
            SELECT $1,$2,$3
            WHERE NOT EXISTS (
              SELECT 1 FROM rss_sources WHERE company_id=$1 AND feed_url=$2
            )
          `,
            [companyId, feed.url, feed.label || null]
          )
        }
      }
      seeded.rss_sources = true
    }

    if (scrapeTargetsCount === 0) {
      for (const { slug, targets } of SCRAPE_TARGETS) {
        const { rows: companyRows } = await query('SELECT id FROM companies WHERE slug=$1', [slug])
        const companyId = companyRows?.[0]?.id
        if (!companyId) continue

        for (const t of targets) {
          await query(
            `
            INSERT INTO scrape_targets
              (company_id, url, label, article_selector, title_selector, summary_selector, date_selector)
            SELECT $1,$2,$3,$4,$5,$6,$7
            WHERE NOT EXISTS (
              SELECT 1 FROM scrape_targets WHERE company_id=$1 AND url=$2
            )
          `,
            [companyId, t.url, t.label || null, t.article_selector, t.title_selector, t.summary_selector, t.date_selector]
          )
        }
      }
      seeded.scrape_targets = true
    }

    const [companiesAfterRows, rssAfterRows, scrapeAfterRows] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM companies'),
      query('SELECT COUNT(*)::int AS count FROM rss_sources'),
      query('SELECT COUNT(*)::int AS count FROM scrape_targets')
    ])

    return {
      seeded,
      before: {
        companies: companiesCount ?? 0,
        rss_sources: rssSourcesCount ?? 0,
        scrape_targets: scrapeTargetsCount ?? 0
      },
      after: {
        companies: Number(companiesAfterRows?.rows?.[0]?.count ?? 0),
        rss_sources: Number(rssAfterRows?.rows?.[0]?.count ?? 0),
        scrape_targets: Number(scrapeAfterRows?.rows?.[0]?.count ?? 0)
      }
    }
  })()

  try {
    return await currentSeedPromise
  } finally {
    currentSeedPromise = null
  }
}

