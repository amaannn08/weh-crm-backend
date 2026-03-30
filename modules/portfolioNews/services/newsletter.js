import { query } from '../db.js'

export async function assembleIssue(issueId) {
  const { rows: issues } = await query('SELECT * FROM newsletter_issues WHERE id = $1', [issueId])
  if (!issues.length) return null
  const issue = issues[0]

  const { rows: segments } = await query(
    `
    SELECT
      s.*,
      c.name        AS company_name,
      c.slug        AS company_slug,
      c.sector      AS company_sector,
      c.fund        AS company_fund,
      c.logo_initials,
      c.logo_color
    FROM newsletter_segments s
    LEFT JOIN companies c ON c.id = s.company_id
    WHERE s.issue_id = $1
    ORDER BY s.sort_order ASC, s.created_at ASC
  `,
    [issueId]
  )

  const { rows: picks } = await query(
    `
    SELECT
      p.id            AS pick_id,
      p.sort_order,
      p.editor_note,
      n.id            AS news_id,
      n.title,
      n.raw_summary   AS summary,
      n.ai_summary,
      n.sentiment,
      n.sentiment_score,
      n.category,
      n.tags,
      n.external_url,
      n.source_label,
      n.published_at,
      c.id            AS company_id,
      c.name          AS company_name,
      c.slug          AS company_slug,
      c.fund,
      c.sector,
      c.stage,
      c.logo_initials,
      c.logo_color
    FROM newsletter_picks p
    JOIN news_items  n ON n.id = p.news_item_id
    JOIN companies   c ON c.id = n.company_id
    WHERE p.issue_id = $1
    ORDER BY p.sort_order ASC, n.published_at DESC
  `,
    [issueId]
  )

  const sentimentCounts = picks.reduce((acc, p) => {
    acc[p.sentiment] = (acc[p.sentiment] || 0) + 1
    return acc
  }, {})

  const fundCounts = picks.reduce((acc, p) => {
    acc[p.fund] = (acc[p.fund] || 0) + 1
    return acc
  }, {})

  return {
    ...issue,
    stats: {
      total_picks: picks.length,
      total_segments: segments.length,
      by_sentiment: sentimentCounts,
      by_fund: fundCounts
    },
    segments,
    picks
  }
}

export async function suggestPicks({ limit = 20, fund, daysSince = 30 } = {}) {
  const params = [limit, daysSince]
  const extra = []

  if (fund) {
    params.push(fund)
    extra.push(`AND c.fund = $${params.length}`)
  }

  const { rows } = await query(
    `
    SELECT
      n.id, n.title, n.raw_summary AS summary, n.sentiment,
      n.sentiment_score, n.category, n.published_at, n.external_url,
      n.source_label,
      c.name AS company_name, c.slug AS company_slug,
      c.fund, c.sector, c.logo_initials, c.logo_color
    FROM news_items n
    JOIN companies c ON c.id = n.company_id
    WHERE n.is_published = TRUE
      AND n.published_at >= NOW() - ($2 || ' days')::INTERVAL
      ${extra.join(' ')}
      AND n.id NOT IN (
        SELECT news_item_id FROM newsletter_picks np
        JOIN newsletter_issues ni ON ni.id = np.issue_id
        WHERE ni.status = 'published'
      )
    ORDER BY
      CASE n.sentiment
        WHEN 'positive' THEN 1
        WHEN 'watch'    THEN 2
        WHEN 'neutral'  THEN 3
        ELSE 4
      END,
      n.sentiment_score DESC,
      n.published_at DESC
    LIMIT $1
  `,
    params
  )

  return rows
}
