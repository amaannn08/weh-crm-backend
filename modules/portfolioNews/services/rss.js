import Parser from 'rss-parser'
import crypto from 'crypto'
import { classifySentiment } from './sentiment.js'
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

  let totalSaved = 0

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.feed_url)
      const relevant = feed.items.filter((item) => isRelevant(item, company.name))

      for (const item of relevant) {
        const saved = await upsertNewsItem({
          company,
          sourceType: 'rss',
          sourceLabel: source.label || feed.title,
          title: item.title?.trim(),
          rawSummary: stripHtml(item.contentSnippet || item.summary || ''),
          externalUrl: item.link,
          publishedAt: item.pubDate ? new Date(item.pubDate) : new Date()
        })
        if (saved) totalSaved += 1
      }

      await query('UPDATE rss_sources SET last_fetched_at=NOW() WHERE id=$1', [source.id])
    } catch (err) {
      console.error(`[rss] Failed to fetch ${source.feed_url}:`, err.message)
    }
  }

  return totalSaved
}

function isRelevant(item, companyName) {
  const haystack = [item.title || '', item.contentSnippet || '', item.summary || '']
    .join(' ')
    .toLowerCase()

  const variants = [companyName.toLowerCase(), companyName.split(/\s+/)[0].toLowerCase()]

  return variants.some((v) => v.length > 2 && haystack.includes(v))
}

export async function upsertNewsItem({
  company,
  sourceType,
  sourceLabel,
  title,
  rawSummary,
  externalUrl,
  publishedAt
}) {
  if (!title) return false

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

  return rowCount > 0
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}
