import axios from 'axios'
import * as cheerio from 'cheerio'
import { query } from '../db.js'
import { upsertNewsItem } from './rss.js'

const HTTP_TIMEOUT = 20000
const USER_AGENT = 'Mozilla/5.0 (compatible; WEHVenturesBot/1.0)'

export async function scrapeForCompany(company) {
  const { rows: targets } = await query(
    'SELECT * FROM scrape_targets WHERE company_id=$1 AND active=TRUE',
    [company.id]
  )

  let totalSaved = 0

  for (const target of targets) {
    try {
      const articles = await scrapePage(target)
      for (const article of articles) {
        const saved = await upsertNewsItem({
          company,
          sourceType: 'scrape',
          sourceLabel: target.label,
          title: article.title,
          rawSummary: article.summary,
          externalUrl: article.url,
          publishedAt: article.publishedAt || new Date()
        })
        if (saved) totalSaved += 1
      }
      await query('UPDATE scrape_targets SET last_scraped_at=NOW() WHERE id=$1', [target.id])
    } catch (err) {
      console.error(`[scrape] Failed ${target.url}:`, err.message)
    }
  }

  return totalSaved
}

async function scrapePage(target) {
  const response = await axios.get(target.url, {
    timeout: HTTP_TIMEOUT,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    maxRedirects: 5
  })

  const $ = cheerio.load(response.data)
  const articles = []

  $(target.article_selector).each((_, el) => {
    const titleEl = $(el).find(target.title_selector).first()
    const title = titleEl.text().trim()
    if (!title || title.length < 10) return

    const href = titleEl.attr('href') || $(el).find('a').first().attr('href') || ''
    const url = resolveUrl(href, target.url)
    const summary = $(el).find(target.summary_selector).first().text().trim().slice(0, 600)
    const dateStr =
      $(el).find(target.date_selector).first().attr('datetime') ||
      $(el).find(target.date_selector).first().text().trim()
    const publishedAt = dateStr ? new Date(dateStr) : null

    articles.push({ title, url, summary, publishedAt })
  })

  return articles
}

function resolveUrl(href, baseUrl) {
  if (!href) return ''
  if (href.startsWith('http')) return href
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}
