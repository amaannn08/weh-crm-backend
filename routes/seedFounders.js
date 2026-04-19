import express from 'express'
import { sql } from '../db/neon.js'

const router = express.Router()

const EXA_API_KEY = process.env.EXA_API_KEY
const WEBSETS_API_URL = 'https://api.exa.ai/websets/v0/websets'
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive'
}
const MAX_WEBSET_WAIT_MS = 480000

async function ensureSeedFoundersTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS seed_founders (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT,
      linkedin_id   TEXT UNIQUE,
      linkedin_url  TEXT,
      title         TEXT,
      company_name  TEXT,
      sector        TEXT,
      background    TEXT,
      location      TEXT,
      stage         TEXT,
      founded_year  TEXT,
      summary       TEXT,
      icp_score     NUMERIC(5,1) DEFAULT 0,
      status        TEXT DEFAULT 'New',
      searched_at   TIMESTAMPTZ DEFAULT now(),
      created_at    TIMESTAMPTZ DEFAULT now()
    )
  `
  await sql`ALTER TABLE seed_founders ADD COLUMN IF NOT EXISTS icp_score NUMERIC(5,1) DEFAULT 0`
  await sql`ALTER TABLE seed_founders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'New'`
}

function normalizeStage(raw = '') {
  const r = raw.toLowerCase()
  if (r.includes('pre-seed') || r.includes('preseed')) return 'Pre-Seed'
  if (r.includes('series c')) return 'Series C+'
  if (r.includes('series b')) return 'Series B'
  if (r.includes('series a')) return 'Series A'
  if (r.includes('seed')) return 'Seed'
  if (r.includes('stealth')) return 'Stealth'
  return raw || 'Seed'
}

function computeIcpScore({ title = '', stage = '', summary = '', background = '' }) {
  let score = 50
  const t = title.toLowerCase()
  if (t.includes('co-founder') || t.includes('cofounder')) score += 15
  else if (t.includes('founder')) score += 12
  if (t.includes('ceo') || t.includes('cto')) score += 5

  const s = stage.toLowerCase()
  if (s.includes('pre-seed') || s.includes('preseed')) score += 10
  if (s.includes('seed')) score += 8
  if (s.includes('stealth')) score += 6

  const bg = background.toLowerCase()
  const eliteSignals = ['iit', 'iim', 'bits', 'google', 'meta', 'microsoft',
    'amazon', 'goldman', 'mckinsey', 'razorpay', 'flipkart', 'stripe',
    'stanford', 'mit', 'openai', 'uber', 'airbnb']
  score += Math.min(eliteSignals.filter(sig => bg.includes(sig)).length * 4, 15)

  const sum = summary.toLowerCase()
  if (sum.includes('building') || sum.includes('founder')) score += 3
  if (sum.includes('raised') || sum.includes('funded')) score += 2

  return Math.min(Math.max(Math.round(score), 0), 100)
}

function buildQuery(params) {
  const parts = []
  const hasQuery = params.query && params.query.trim() !== ''

  if (hasQuery) {
    parts.push(params.query.trim())
  } else {
    parts.push('Founder or Co-Founder of a')
  }

  if (params.stage) parts.push(params.stage)
  if (params.sectors?.length) parts.push(params.sectors.join(' or '))
  
  if (!hasQuery) {
    parts.push('startup')
  }

  if (params.location && params.location !== 'India' && params.location !== 'All India') parts.push('in ' + params.location)
  if (params.year) parts.push('founded in ' + params.year)
  if (params.backgrounds?.length) {
    parts.push('with background from ' + params.backgrounds.join(' or '))
  }
  
  return parts.join(' ')
}

function buildCriteria(params) {
  const criteria = []
  const hasQuery = params.query && params.query.trim() !== ''

  if (!hasQuery) {
    // Default strict criteria for empty chatbox (finding founders)
    criteria.push({ description: 'Currently a Founder or Co-Founder (not employee or manager)', successRate: 95 })
    if (params.location && params.location !== 'India' && params.location !== 'All India') {
      criteria.push({ description: `Based in ${params.location}`, successRate: 90 })
    } else {
      criteria.push({ description: 'Based in India (any city)', successRate: 95 })
    }
  } else {
    // If custom chat query provided, only apply location if explicitly set
    if (params.location && params.location !== 'India' && params.location !== 'All India') {
      criteria.push({ description: `Based in ${params.location}`, successRate: 90 })
    }
  }

  if (params.year && params.stage) {
    criteria.push({ description: `Company is ${params.stage} and founded in ${params.year}`, successRate: 88 })
  } else if (params.year) {
    criteria.push({ description: `Company founded in ${params.year}`, successRate: 90 })
  } else if (params.stage) {
    criteria.push({ description: `Company is ${params.stage} (not Series A or later)`, successRate: 85 })
  }

  if (params.backgrounds?.length && criteria.length < 5) {
    criteria.push({ description: `Alumni or ex-employee of: ${params.backgrounds.join(', ')}`, successRate: 85 })
  }

  if (params.sectors?.length && criteria.length < 5) {
    criteria.push({ description: `Building in ${params.sectors.join(' or ')} sector`, successRate: 80 })
  }

  return criteria.slice(0, 5)
}

async function createWebset(query, criteria, count) {
  const searchPayload = { query, entity: { type: 'person' }, count }
  
  // Only attach criteria if we have them, otherwise let Exa handle the query breakdown natively
  if (criteria && criteria.length > 0) {
    searchPayload.criteria = criteria
  }

  const res = await fetch(WEBSETS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_API_KEY },
    body: JSON.stringify({
      title: `Sahourai Search - ${new Date().toLocaleDateString()}`,
      search: searchPayload,
      enrichments: []
    })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Exa API error ${res.status}: ${text}`)
  }
  const data = await res.json()
  if (!data.id) throw new Error('No Webset ID returned')
  return data.id
}

function emitSse(res, event, payload) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function getWebsetStatus(websetId) {
  const res = await fetch(`${WEBSETS_API_URL}/${websetId}`, {
    headers: { 'x-api-key': EXA_API_KEY }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get webset status (${res.status}): ${text}`)
  }
  return res.json()
}

async function getWebsetItems(websetId) {
  const res = await fetch(`${WEBSETS_API_URL}/${websetId}/items`, {
    headers: { 'x-api-key': EXA_API_KEY }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get webset items (${res.status}): ${text}`)
  }
  const data = await res.json()
  return data.data || []
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pollIntervalForElapsed(elapsedMs) {
  if (elapsedMs < 30_000) return 1_500
  if (elapsedMs < 120_000) return 3_000
  return 5_000
}

function dedupeKeyForItem(item) {
  const props = item?.properties || {}
  const person = props.person || {}
  return item?.id
    || props.url
    || person.linkedinUrl
    || person.linkedinProfileUrl
    || `${person.name || ''}:${person.position || ''}:${person.location || ''}`
}

async function streamWebsetWithAdaptivePolling(websetId, params, onEvent) {
  const start = Date.now()
  const seenKeys = new Set()
  const normalizedRows = []
  let transientFailures = 0
  let lastStatus = 'starting'

  while (Date.now() - start < MAX_WEBSET_WAIT_MS) {
    const elapsedMs = Date.now() - start
    const intervalMs = pollIntervalForElapsed(elapsedMs)
    await sleep(intervalMs)

    let status
    let items
    try {
      [status, items] = await Promise.all([
        getWebsetStatus(websetId),
        getWebsetItems(websetId)
      ])
      transientFailures = 0
    } catch (err) {
      transientFailures += 1
      if (transientFailures > 1) throw err
      onEvent('progress', {
        source: 'adaptive-poll',
        status: lastStatus,
        foundCount: normalizedRows.length,
        newCount: 0,
        elapsedMs,
        intervalMs,
        message: 'Temporary fetch issue, retrying...'
      })
      continue
    }

    lastStatus = status.status || 'processing'
    const newlyFound = []
    for (const item of items) {
      const key = dedupeKeyForItem(item)
      if (!key || seenKeys.has(key)) continue
      seenKeys.add(key)
      const row = normalizeFounder(item, params)
      normalizedRows.push(row)
      newlyFound.push(row)
    }

    if (newlyFound.length) {
      onEvent('item_batch', {
        source: 'adaptive-poll',
        websetId,
        batchCount: newlyFound.length,
        totalSoFar: normalizedRows.length,
        results: newlyFound
      })
    }

    onEvent('progress', {
      source: 'adaptive-poll',
      status: lastStatus,
      foundCount: normalizedRows.length,
      newCount: newlyFound.length,
      elapsedMs,
      intervalMs,
      message: `Webset status: ${lastStatus} (${normalizedRows.length} found)`
    })

    if (lastStatus === 'idle' || lastStatus === 'completed') {
      return normalizedRows
    }
    if (lastStatus === 'canceled' || lastStatus === 'failed') {
      throw new Error(`Webset ${lastStatus}`)
    }
  }

  throw new Error('Webset timed out before completion')
}

function normalizeFounder(item, params) {
  const { url, name, title, companyName, location, summary } = extractFields(item)
  const linkedinId = extractLinkedInId(url)
  const stage = normalizeStage(params.stage || '')
  const icpScore = computeIcpScore({
    title,
    stage,
    summary,
    background: params.backgrounds?.join(' ') || ''
  })

  return {
    name, linkedin_id: linkedinId, linkedin_url: url, title,
    company_name: companyName,
    sector: params.sectors?.join(', ') || '',
    background: params.backgrounds?.join(', ') || '',
    location: location || params.location || 'India',
    stage, founded_year: params.year || '',
    summary, icp_score: icpScore, status: 'New'
  }
}

function extractLinkedInId(url = '') {
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/)
  return match ? match[1] : null
}

function extractFields(item) {
  const props = item.properties || {}
  const person = props.person || {}
  const company = person.company || {}
  return {
    url: props.url || '',
    name: person.name || '',
    title: person.position || 'Founder',
    companyName: company.name || 'Startup',
    location: person.location || '',
    summary: props.description || ''
  }
}

async function upsertFounder(row) {
  if (row.linkedin_id) {
    await sql`
      INSERT INTO seed_founders (name, linkedin_id, linkedin_url, title, company_name,
        sector, background, location, stage, founded_year, summary, icp_score, status)
      VALUES (${row.name}, ${row.linkedin_id}, ${row.linkedin_url}, ${row.title}, ${row.company_name},
        ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
        ${row.summary}, ${row.icp_score}, 'New')
      ON CONFLICT (linkedin_id) DO NOTHING
    `
    const check = await sql`SELECT id FROM seed_founders WHERE linkedin_id = ${row.linkedin_id}`
    return check.length ? 'added' : 'duplicate'
  } else {
    await sql`
      INSERT INTO seed_founders (name, linkedin_id, linkedin_url, title, company_name,
        sector, background, location, stage, founded_year, summary, icp_score, status)
      VALUES (${row.name}, ${null}, ${row.linkedin_url}, ${row.title}, ${row.company_name},
        ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
        ${row.summary}, ${row.icp_score}, 'New')
    `
    return 'added'
  }
}

// ─── POST /seed-founders/search ─────────────────────────────────────────────
router.post('/search', async (req, res) => {
  try {
    if (!EXA_API_KEY) throw new Error('EXA_API_KEY not configured')

    await ensureSeedFoundersTable()

    const params = req.body
    const shouldSave = params.save !== false  // default true, pass save:false for preview
    const count = Math.min(params.count || 25, 100)
    
    const query = buildQuery(params)
    const criteria = buildCriteria(params)

    console.log(`[seedFounders] webset search: "${query}" (n=${count}, save=${shouldSave})`)

    res.writeHead(200, SSE_HEADERS)
    res.flushHeaders?.()

    const websetId = await createWebset(query, criteria, count)
    emitSse(res, 'ready', {
      websetId,
      message: 'Webset created. Starting adaptive live updates...'
    })

    emitSse(res, 'contract', {
      progress: {
        fields: ['source', 'status', 'foundCount', 'newCount', 'elapsedMs', 'intervalMs', 'message']
      },
      item_batch: {
        fields: ['source', 'websetId', 'batchCount', 'totalSoFar', 'results']
      },
      done: {
        fields: ['success', 'added', 'duplicates', 'total', 'results', 'message']
      }
    })

    const results = await streamWebsetWithAdaptivePolling(websetId, params, (event, payload) => {
      emitSse(res, event, payload)
    })

    if (!results.length) {
      emitSse(res, 'done', { success: false, message: 'No founders found. Try broader search.' })
      return res.end()
    }

    let added = 0, duplicates = 0

    for (const row of results) {
      if (shouldSave) {
        try {
          const outcome = await upsertFounder(row)
          if (outcome === 'added') added++; else duplicates++
        } catch (e) {
          if (e.code === '23505') duplicates++
          else console.error('[seedFounders] insert error:', e.message)
        }
      }
    }

    emitSse(res, 'done', {
      success: true, added: shouldSave ? added : 0,
      duplicates: shouldSave ? duplicates : 0,
      total: results.length,
      results: results.sort((a, b) => b.icp_score - a.icp_score),
      message: shouldSave
        ? `Found ${results.length} founders — ${added} new, ${duplicates} duplicates`
        : `Found ${results.length} founders`
    })
    return res.end()
  } catch (err) {
    console.error('[seedFounders] search error:', err)
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message })
    }
    emitSse(res, 'error', { success: false, message: err.message || 'Search failed' })
    return res.end()
  }
})

// ─── POST /seed-founders/save-batch ─────────────────────────────────────────
router.post('/save-batch', async (req, res) => {
  try {
    await ensureSeedFoundersTable()
    const { founders = [] } = req.body
    let added = 0, duplicates = 0

    for (const row of founders) {
      try {
        const outcome = await upsertFounder(row)
        if (outcome === 'added') added++; else duplicates++
      } catch (e) {
        if (e.code === '23505') duplicates++
        else console.error('[seedFounders] batch insert error:', e.message)
      }
    }

    return res.json({ success: true, added, duplicates })
  } catch (err) {
    console.error('[seedFounders] save-batch error:', err)
    return res.status(500).json({ success: false, message: err.message })
  }
})

// ─── GET /seed-founders ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    await ensureSeedFoundersTable()
    const { search, stage, status, limit = 200, offset = 0 } = req.query
    const q = search ? `%${search}%` : null

    let rows
    if (q && stage && stage !== 'All stages' && status && status !== 'All') {
      rows = await sql`SELECT * FROM seed_founders WHERE (name ILIKE ${q} OR company_name ILIKE ${q} OR title ILIKE ${q}) AND stage ILIKE ${'%' + stage + '%'} AND status = ${status} ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    } else if (q && status && status !== 'All') {
      rows = await sql`SELECT * FROM seed_founders WHERE (name ILIKE ${q} OR company_name ILIKE ${q} OR title ILIKE ${q}) AND status = ${status} ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    } else if (q && stage && stage !== 'All stages') {
      rows = await sql`SELECT * FROM seed_founders WHERE (name ILIKE ${q} OR company_name ILIKE ${q} OR title ILIKE ${q}) AND stage ILIKE ${'%' + stage + '%'} ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    } else if (q) {
      rows = await sql`SELECT * FROM seed_founders WHERE name ILIKE ${q} OR company_name ILIKE ${q} OR title ILIKE ${q} ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    } else if (status && status !== 'All') {
      rows = await sql`SELECT * FROM seed_founders WHERE status = ${status} ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    } else {
      rows = await sql`SELECT * FROM seed_founders ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    }

    // Return status counts for tab badges
    const counts = await sql`SELECT status, COUNT(*)::int as cnt FROM seed_founders GROUP BY status`
    const statusCounts = Object.fromEntries(counts.map(r => [r.status, r.cnt]))

    return res.json({ founders: rows, statusCounts })
  } catch (err) {
    console.error('[seedFounders] list error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /seed-founders/:id/status ────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body
    const allowed = ['New', 'Contacted', 'In Review', 'Pass', 'Invested']
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    const rows = await sql`UPDATE seed_founders SET status = ${status} WHERE id = ${id} RETURNING *`
    return res.json(rows[0])
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── DELETE /seed-founders/:id ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await sql`DELETE FROM seed_founders WHERE id = ${req.params.id}`
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

export default router
