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

  if (!targets.length) {
    console.log('[scrape] No active scrape targets for company', {
      companyId: company.id,
      slug: company.slug,
      name: company.name
    })
  } else {
    console.log('[scrape] Active scrape targets for company', {
      companyId: company.id,
      slug: company.slug,
      name: company.name,
      targetCount: targets.length
    })
  }

  let totalSaved = 0

  for (const target of targets) {
    try {
      console.log('[scrape] Fetching page', {
        companySlug: company.slug,
        companyName: company.name,
        targetId: target.id,
        url: target.url,
        label: target.label
      })

      const { articles, status, finalUrl } = await scrapePage(target)

      console.log('[scrape] Parsed articles', {
        companySlug: company.slug,
        companyName: company.name,
        targetId: target.id,
        url: target.url,
        status,
        finalUrl,
        articleCount: articles.length
      })
      if (articles.length > 0) {
        console.log('[scrape] Article sample', {
          companySlug: company.slug,
          companyName: company.name,
          targetId: target.id,
          url: target.url,
          sample: articles.slice(0, 3).map((a) => ({ title: a.title, url: a.url }))
        })
      }

      let inserted = 0
      let deduped = 0
      let skippedNoTitle = 0
      let irrelevant = 0
      for (const article of articles) {
        const result = await upsertNewsItem({
          company,
          sourceType: 'scrape',
          sourceLabel: target.label,
          title: article.title,
          rawSummary: article.summary,
          externalUrl: article.url,
          publishedAt: article.publishedAt || new Date()
        })
        if (result.inserted) {
          totalSaved += 1
          inserted += 1
        } else if (result.reason === 'dedup') {
          deduped += 1
        } else if (result.reason === 'no_title') {
          skippedNoTitle += 1
        } else if (result.reason === 'irrelevant') {
          irrelevant += 1
        }
      }
      if (articles.length > 0) {
        console.log('[scrape] Target upsert summary', {
          companySlug: company.slug,
          companyName: company.name,
          targetId: target.id,
          url: target.url,
          articleCount: articles.length,
          inserted,
          irrelevant,
          deduped,
          skippedNoTitle
        })
      }
      await query('UPDATE scrape_targets SET last_scraped_at=NOW() WHERE id=$1', [target.id])
    } catch (err) {
      console.error('[scrape] Failed target', {
        companySlug: company.slug,
        companyName: company.name,
        targetId: target.id,
        url: target.url,
        error: err?.message || String(err)
      })
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

  const finalUrl =
    response?.request?.res?.responseUrl ||
    response?.request?._redirectable?._currentUrl ||
    target.url

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

  return { articles, status: response.status, finalUrl }
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
