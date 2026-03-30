import { Router } from 'express'
import { authMiddleware } from '../../../middleware/auth.js'
import { query, getClient } from '../db.js'
import { assembleIssue, suggestPicks } from '../services/newsletter.js'
import { renderIssue } from '../services/renderer.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { status } = req.query
    const params = []
    const where = []
    if (status) { params.push(status); where.push(`status=$${params.length}`) }

    const { rows } = await query(
      `
      SELECT
        ni.*,
        COUNT(DISTINCT np.id) AS pick_count,
        COUNT(DISTINCT ns.id) AS segment_count
      FROM newsletter_issues ni
      LEFT JOIN newsletter_picks    np ON np.issue_id = ni.id
      LEFT JOIN newsletter_segments ns ON ns.issue_id = ni.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY ni.id
      ORDER BY ni.created_at DESC
    `,
      params
    )
    return res.json(rows)
  } catch (err) {
    console.error('[GET /newsletters]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/suggest', async (req, res) => {
  try {
    const { limit = 30, fund, days = 30 } = req.query
    const picks = await suggestPicks({ limit: parseInt(limit, 10), fund: fund || undefined, daysSince: parseInt(days, 10) })
    return res.json(picks)
  } catch (err) {
    console.error('[GET /newsletters/suggest]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const issue = await assembleIssue(parseInt(req.params.id, 10))
    if (!issue) return res.status(404).json({ error: 'Issue not found' })
    return res.json(issue)
  } catch (err) {
    console.error('[GET /newsletters/:id]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id/render', async (req, res) => {
  try {
    const issue = await assembleIssue(parseInt(req.params.id, 10))
    if (!issue) return res.status(404).json({ error: 'Issue not found' })
    const html = renderIssue(issue)
    if (req.headers.accept?.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html')
      return res.send(html)
    }
    return res.json({ html })
  } catch (err) {
    console.error('[GET /newsletters/:id/render]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, period_label: periodLabel, created_by: createdBy } = req.body
    if (!title) return res.status(400).json({ error: 'title is required' })
    const { rows } = await query(
      'INSERT INTO newsletter_issues (title, period_label, created_by) VALUES ($1, $2, $3) RETURNING *',
      [title, periodLabel || null, createdBy || null]
    )
    return res.status(201).json(rows[0])
  } catch (err) {
    console.error('[POST /newsletters]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { title, period_label: periodLabel, status, created_by: createdBy } = req.body
    const updates = []
    const params = []

    if (title !== undefined) { params.push(title); updates.push(`title=$${params.length}`) }
    if (periodLabel !== undefined) { params.push(periodLabel); updates.push(`period_label=$${params.length}`) }
    if (createdBy !== undefined) { params.push(createdBy); updates.push(`created_by=$${params.length}`) }
    if (status !== undefined) {
      const valid = ['draft', 'in_review', 'published']
      if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
      params.push(status)
      updates.push(`status=$${params.length}`)
      if (status === 'published') updates.push('published_at=NOW()')
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    params.push(req.params.id)
    const { rows } = await query(
      `UPDATE newsletter_issues SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' })
    return res.json(rows[0])
  } catch (err) {
    console.error('[PATCH /newsletters/:id]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await query(
      "DELETE FROM newsletter_issues WHERE id=$1 AND status='draft'",
      [req.params.id]
    )
    if (!rowCount) return res.status(404).json({ error: 'Draft issue not found (can only delete drafts)' })
    return res.json({ success: true })
  } catch (err) {
    console.error('[DELETE /newsletters/:id]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/:id/picks', authMiddleware, async (req, res) => {
  try {
    const issueId = parseInt(req.params.id, 10)
    const { news_item_id: newsItemId, news_item_ids: newsItemIds, editor_note: editorNote, sort_order: sortOrder } = req.body
    const ids = newsItemIds || (newsItemId ? [newsItemId] : [])
    if (!ids.length) return res.status(400).json({ error: 'news_item_id or news_item_ids required' })

    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max FROM newsletter_picks WHERE issue_id=$1',
      [issueId]
    )
    let nextOrder = parseInt(maxRows[0].max, 10) + 10
    const inserted = []

    for (const nid of ids) {
      const { rows } = await query(
        `
        INSERT INTO newsletter_picks (issue_id, news_item_id, sort_order, editor_note)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (issue_id, news_item_id) DO UPDATE SET
          editor_note  = COALESCE(EXCLUDED.editor_note, newsletter_picks.editor_note),
          sort_order   = COALESCE($3, newsletter_picks.sort_order)
        RETURNING *
      `,
        [issueId, nid, sortOrder || nextOrder, editorNote || null]
      )
      inserted.push(rows[0])
      nextOrder += 10
    }

    return res.status(201).json(inserted.length === 1 ? inserted[0] : inserted)
  } catch (err) {
    console.error('[POST /newsletters/:id/picks]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/:id/picks/:pickId', authMiddleware, async (req, res) => {
  try {
    const { editor_note: editorNote, sort_order: sortOrder } = req.body
    const updates = []
    const params = []
    if (editorNote !== undefined) { params.push(editorNote); updates.push(`editor_note=$${params.length}`) }
    if (sortOrder !== undefined) { params.push(sortOrder); updates.push(`sort_order=$${params.length}`) }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    params.push(req.params.pickId, req.params.id)
    const { rows } = await query(
      `UPDATE newsletter_picks SET ${updates.join(', ')} WHERE id=$${params.length - 1} AND issue_id=$${params.length} RETURNING *`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Pick not found' })
    return res.json(rows[0])
  } catch (err) {
    console.error('[PATCH /newsletters/:id/picks/:pickId]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id/picks/:pickId', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM newsletter_picks WHERE id=$1 AND issue_id=$2',
      [req.params.pickId, req.params.id]
    )
    if (!rowCount) return res.status(404).json({ error: 'Pick not found' })
    return res.json({ success: true })
  } catch (err) {
    console.error('[DELETE /newsletters/:id/picks/:pickId]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/:id/picks/reorder', authMiddleware, async (req, res) => {
  try {
    const { order } = req.body
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (const { pick_id: pickId, sort_order: sortOrder } of order) {
        await client.query(
          'UPDATE newsletter_picks SET sort_order=$1 WHERE id=$2 AND issue_id=$3',
          [sortOrder, pickId, req.params.id]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return res.json({ success: true })
  } catch (err) {
    console.error('[POST /newsletters/:id/picks/reorder]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id/segments', async (req, res) => {
  try {
    const { rows } = await query(
      `
      SELECT s.*, c.name AS company_name, c.slug AS company_slug
      FROM newsletter_segments s
      LEFT JOIN companies c ON c.id = s.company_id
      WHERE s.issue_id = $1
      ORDER BY s.sort_order ASC, s.created_at ASC
    `,
      [req.params.id]
    )
    return res.json(rows)
  } catch (err) {
    console.error('[GET /newsletters/:id/segments]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/:id/segments', authMiddleware, async (req, res) => {
  try {
    const { segment_type: segmentType, title, body, company_slug: companySlug, sort_order: sortOrder, created_by: createdBy } = req.body
    const validTypes = ['portfolio_highlights', 'market_context', 'founder_spotlight', 'custom']
    if (!segmentType || !validTypes.includes(segmentType)) {
      return res.status(400).json({ error: `segment_type must be one of: ${validTypes.join(', ')}` })
    }

    let companyId = null
    if (companySlug) {
      const { rows } = await query('SELECT id FROM companies WHERE slug=$1', [companySlug])
      if (!rows.length) return res.status(404).json({ error: `Company "${companySlug}" not found` })
      companyId = rows[0].id
    }

    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max FROM newsletter_segments WHERE issue_id=$1',
      [req.params.id]
    )
    const nextOrder = sortOrder ?? (parseInt(maxRows[0].max, 10) + 10)

    const { rows } = await query(
      `
      INSERT INTO newsletter_segments
        (issue_id, segment_type, title, body, company_id, sort_order, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `,
      [req.params.id, segmentType, title || null, body || null, companyId, nextOrder, createdBy || null]
    )
    return res.status(201).json(rows[0])
  } catch (err) {
    console.error('[POST /newsletters/:id/segments]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/:id/segments/:segId', authMiddleware, async (req, res) => {
  try {
    const { title, body, sort_order: sortOrder, created_by: createdBy, company_slug: companySlug } = req.body
    const updates = []
    const params = []
    if (title !== undefined) { params.push(title); updates.push(`title=$${params.length}`) }
    if (body !== undefined) { params.push(body); updates.push(`body=$${params.length}`) }
    if (sortOrder !== undefined) { params.push(sortOrder); updates.push(`sort_order=$${params.length}`) }
    if (createdBy !== undefined) { params.push(createdBy); updates.push(`created_by=$${params.length}`) }
    if (companySlug !== undefined) {
      if (companySlug === null) {
        updates.push('company_id=NULL')
      } else {
        const { rows } = await query('SELECT id FROM companies WHERE slug=$1', [companySlug])
        if (!rows.length) return res.status(404).json({ error: `Company "${companySlug}" not found` })
        params.push(rows[0].id)
        updates.push(`company_id=$${params.length}`)
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    params.push(req.params.segId, req.params.id)
    const { rows } = await query(
      `UPDATE newsletter_segments SET ${updates.join(', ')} WHERE id=$${params.length - 1} AND issue_id=$${params.length} RETURNING *`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Segment not found' })
    return res.json(rows[0])
  } catch (err) {
    console.error('[PATCH /newsletters/:id/segments/:segId]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id/segments/:segId', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM newsletter_segments WHERE id=$1 AND issue_id=$2',
      [req.params.segId, req.params.id]
    )
    if (!rowCount) return res.status(404).json({ error: 'Segment not found' })
    return res.json({ success: true })
  } catch (err) {
    console.error('[DELETE /newsletters/:id/segments/:segId]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
