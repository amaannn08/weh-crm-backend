import Parser from 'rss-parser'
import crypto from 'crypto'
import { classifySentiment } from './sentiment.js'
import { checkRelevance } from './relevance.js'
import { query } from '../db.js'

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'WEHVentures-NewsBot/1.0' },
  customFields: { item: ['media:content', 'enclosure'] }
})

export async function ingestRssForCompany(company) {
  const { rows: sources } = await query(
    'SELECT * FROM rss_sources WHERE company_id=$1 AND active=TRUE',
    [company.id]
  )

  if (!sources.length) {
    console.log('[rss] No active sources for company', {
      companyId: company.id,
      slug: company.slug,
      name: company.name
    })
  } else {
    console.log('[rss] Active sources for company', {
      companyId: company.id,
      slug: company.slug,
      name: company.name,
      sourceCount: sources.length
    })
  }

  let totalSaved = 0

  for (const source of sources) {
    try {
      console.log('[rss] Fetching feed', {
        companySlug: company.slug,
        companyName: company.name,
        sourceId: source.id,
        feedUrl: source.feed_url,
        label: source.label
      })

      const feed = await parser.parseURL(source.feed_url)

      console.log('[rss] Feed fetched', {
        companySlug: company.slug,
        companyName: company.name,
        sourceId: source.id,
        feedUrl: source.feed_url,
        itemCount: feed.items?.length ?? 0
      })

      const matches = (feed.items || [])
        .map((item) => ({ item, matchedVariant: matchVariant(item, company) }))
        .filter((x) => x.matchedVariant)

      console.log('[rss] Relevant items', {
        companySlug: company.slug,
        companyName: company.name,
        sourceId: source.id,
        feedUrl: source.feed_url,
        relevantCount: matches.length
      })

      if (matches.length > 0) {
        const sample = matches.slice(0, 3).map(({ item, matchedVariant }) => ({
          title: item.title?.trim() || null,
          link: item.link || null,
          matchedVariant
        }))
        console.log('[rss] Relevant sample', {
          companySlug: company.slug,
          companyName: company.name,
          sourceId: source.id,
          feedUrl: source.feed_url,
          sample
        })
      }

      let inserted = 0
      let deduped = 0
      let skippedNoTitle = 0
      let irrelevant = 0
      for (const { item, matchedVariant } of matches) {
        const result = await upsertNewsItem({
          company,
          sourceType: 'rss',
          sourceLabel: source.label || feed.title,
          title: item.title?.trim(),
          rawSummary: stripHtml(item.contentSnippet || item.summary || ''),
          externalUrl: item.link,
          publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
          matchedVariant
        })
        if (result.inserted) {
          totalSaved += 1
          inserted += 1
        } else if (result.reason === 'no_title') {
          skippedNoTitle += 1
        } else if (result.reason === 'dedup') {
          deduped += 1
        } else if (result.reason === 'irrelevant') {
          irrelevant += 1
        }
      }

      if (matches.length > 0) {
        console.log('[rss] Feed upsert summary', {
          companySlug: company.slug,
          companyName: company.name,
          sourceId: source.id,
          feedUrl: source.feed_url,
          matched: matches.length,
          inserted,
          irrelevant,
          deduped,
          skippedNoTitle
        })
      }

      await query('UPDATE rss_sources SET last_fetched_at=NOW() WHERE id=$1', [source.id])
    } catch (err) {
      console.error('[rss] Failed to fetch feed', {
        companySlug: company.slug,
        companyName: company.name,
        sourceId: source.id,
        feedUrl: source.feed_url,
        error: err?.message || String(err)
      })
    }
  }

  return totalSaved
}

function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function companyVariants(company) {
  const variants = new Set()

  const name = normalizeToken(company.name)
  const slug = normalizeToken(company.slug).replace(/-/g, ' ')

  if (name) variants.add(name)
  if (slug) variants.add(slug)

  const firstWord = name.split(' ')[0]
  if (firstWord && firstWord.length > 2) variants.add(firstWord)

  // Handle parentheses, e.g. "Magma (Taozen)" → "magma", "taozen"
  const noParen = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (noParen) variants.add(noParen)
  const paren = name.match(/\(([^)]+)\)/)?.[1]
  if (paren) variants.add(normalizeToken(paren))

  // Extra slug forms
  const slugNoSpaces = normalizeToken(company.slug).replace(/-/g, '')
  if (slugNoSpaces.length > 2) variants.add(slugNoSpaces)

  return Array.from(variants).filter((v) => v.length > 2)
}

function matchVariant(item, company) {
  const haystack = [item.title || '', item.contentSnippet || '', item.summary || '']
    .join(' ')
  const text = normalizeToken(haystack)

  for (const v of companyVariants(company)) {
    if (text.includes(v)) return v
  }
  return null
}

export async function upsertNewsItem({
  company,
  sourceType,
  sourceLabel,
  title,
  rawSummary,
  externalUrl,
  publishedAt,
  matchedVariant
}) {
  if (!title) return { inserted: false, reason: 'no_title' }

  // LLM relevance gate — drop articles that only keyword-matched but aren't
  // actually about this company
  const { relevant, reason: relevanceReason } = await checkRelevance({
    title,
    summary: rawSummary || '',
    companyName: company.name,
    companySlug: company.slug
  })
  if (!relevant) {
    console.log('[rss] Skipped irrelevant article', {
      companySlug: company.slug,
      companyName: company.name,
      title: title.slice(0, 120),
      reason: relevanceReason
    })
    return { inserted: false, reason: 'irrelevant' }
  }

  const hash = crypto
    .createHash('sha256')
    .update(`${company.id}::${title.slice(0, 120)}`)
    .digest('hex')

  const { sentiment, score, category } = classifySentiment(title, rawSummary, company.name)

  const { rowCount } = await query(
    `
    INSERT INTO news_items
      (company_id, source_type, source_label, external_url, title,
       raw_summary, sentiment, sentiment_score, category, published_at, dedup_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (dedup_hash) DO NOTHING
  `,
    [
      company.id,
      sourceType,
      sourceLabel,
      externalUrl,
      title,
      rawSummary,
      sentiment,
      score,
      category,
      publishedAt,
      hash
    ]
  )

  if (rowCount > 0) {
    if (matchedVariant) {
      console.log('[rss] Inserted item', {
        companySlug: company.slug,
        companyName: company.name,
        matchedVariant,
        title: title.slice(0, 200),
        externalUrl: externalUrl || null
      })
    }
    return { inserted: true }
  }

  // Distinguish dedup vs other no-op by checking the hash.
  const { rows } = await query('SELECT 1 FROM news_items WHERE dedup_hash=$1 LIMIT 1', [hash])
  if (rows?.length) {
    return { inserted: false, reason: 'dedup' }
  }
  return { inserted: false, reason: 'no_change' }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}
