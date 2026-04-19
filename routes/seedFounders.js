import express from 'express'
import Exa from 'exa-js'
import { sql } from '../db/neon.js'

const router = express.Router()

function getExa() {
  const key = process.env.EXA_API_KEY
  if (!key) throw new Error('EXA_API_KEY not configured')
  return new Exa(key)
}

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
  const parts = ['Founder or Co-Founder']
  if (params.sectors?.length) parts.push(`in ${params.sectors.join(' or ')}`)
  if (params.stage) parts.push(`at ${params.stage} stage`)
  if (params.location) parts.push(`based in ${params.location}`)
  if (params.year) parts.push(`company founded in ${params.year}`)
  if (params.backgrounds?.length) parts.push(`from ${params.backgrounds.join(' or ')}`)
  return parts.join(', ')
}

function parseLinkedInTitle(raw = '') {
  let cleaned = raw.replace(/\s*[-|]\s*LinkedIn\s*$/i, '').trim()
  const parts = cleaned.split(/\s*[-|–—,]\s*/).filter(p => p.length > 0)
  let name = parts[0] || ''
  let title = ''
  let companyName = ''

  name = name.replace(/^(Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+/i, '').trim()

  const nameAtMatch = name.match(/^(.*?)\s+(?:at|@)\s+(.*)$/i)
  if (nameAtMatch) { name = nameAtMatch[1].trim(); companyName = nameAtMatch[2].trim() }

  const titleKeywords = ['founder', 'ceo', 'cto', 'director', 'manager', 'head', 'lead', 'vp', 'president', 'partner']
  let titleIdx = -1
  for (let i = 1; i < parts.length; i++) {
    if (titleKeywords.some(kw => parts[i].toLowerCase().includes(kw))) { titleIdx = i; break }
  }

  if (titleIdx !== -1) {
    title = parts[titleIdx].trim()
    companyName = parts.slice(titleIdx + 1).join(' | ').trim()
  } else if (parts.length > 1) {
    title = parts[1].trim()
    companyName = parts.slice(2).join(' | ').trim()
  }

  const titleAtMatch = title.match(/^(.*?)\s+(?:at|@)\s+(.*)$/i)
  if (titleAtMatch) {
    title = titleAtMatch[1].trim()
    companyName = companyName ? titleAtMatch[2].trim() + ' | ' + companyName : titleAtMatch[2].trim()
  }

  return { name, title, companyName }
}

function extractLinkedInId(url = '') {
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/)
  return match ? match[1] : null
}

function extractFromHighlights(highlights = []) {
  const text = highlights.join(' ')
  const cities = ['Bengaluru', 'Bangalore', 'Mumbai', 'Delhi', 'Hyderabad',
    'Chennai', 'Pune', 'Kolkata', 'Ahmedabad', 'Gurgaon', 'Noida']
  const found = cities.find(c => text.includes(c))
  return { location: found || '', summary: text.slice(0, 400) }
}

function buildRowData(item, params) {
  const url = item.url || ''
  const { name, title, companyName } = parseLinkedInTitle(item.title || '')
  const { location, summary } = extractFromHighlights(item.highlights || [])
  const linkedinId = extractLinkedInId(url)
  const stage = normalizeStage(params.stage || '')
  const icpScore = computeIcpScore({ title, stage, summary, background: params.backgrounds?.join(' ') || '' })

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
    const exa = getExa()
    await ensureSeedFoundersTable()

    const params = req.body
    const shouldSave = params.save !== false  // default true, pass save:false for preview
    const count = Math.min(params.count || 25, 100)
    const query = buildQuery(params)

    console.log(`[seedFounders] searching: "${query}" (n=${count}, save=${shouldSave})`)

    const searchRes = await exa.search(query, {
      type: 'auto', num_results: count, category: 'person',
      includeDomains: ['linkedin.com'],
      contents: { highlights: { max_characters: 2000 } }
    })

    const items = (searchRes.results || []).filter(r => /linkedin\.com\/in\//.test(r.url))
    if (!items.length) return res.json({ success: false, message: 'No founders found. Try broader search.' })

    let added = 0, duplicates = 0
    const results = []

    for (const item of items) {
      const row = buildRowData(item, params)
      results.push(row)
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

    return res.json({
      success: true, added: shouldSave ? added : 0,
      duplicates: shouldSave ? duplicates : 0,
      total: items.length,
      results: results.sort((a, b) => b.icp_score - a.icp_score),
      message: shouldSave
        ? `Found ${items.length} founders — ${added} new, ${duplicates} duplicates`
        : `Found ${items.length} founders`
    })
  } catch (err) {
    console.error('[seedFounders] search error:', err)
    return res.status(500).json({ success: false, message: err.message })
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
