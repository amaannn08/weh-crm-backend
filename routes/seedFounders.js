import express from 'express'
import { sql, query as dbQuery } from '../db/neon.js'

const router = express.Router()

const EXA_API_KEY = process.env.EXA_API_KEY
const WEBSETS_API_URL = 'https://api.exa.ai/websets/v0/websets'
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive'
}
const MAX_WEBSET_WAIT_MS = 480000
const canceledWebsets = new Set()

function sanitizeErrorMessage(input) {
  const raw = (input instanceof Error ? input.message : String(input || '')) || ''
  if (!raw) return 'Search failed. Please try again.'

  if (raw === 'Seeding cancelled by user') return raw
  if (raw === 'Search cancelled') return raw

  const lower = raw.toLowerCase()

  if (lower.includes('credit') && (lower.includes('enough') || lower.includes('finish') || lower.includes('insufficient') || lower.includes('more credits'))) {
    return 'Search credits finished. Please try again later.'
  }
  if (lower.includes('rate limit') || lower.includes(' 429')) {
    return 'Too many requests — please wait a moment and try again.'
  }
  if (lower.includes('unauthorized') || lower.includes(' 401') || lower.includes('forbidden') || lower.includes(' 403')) {
    return 'Search service unavailable. Please try again later.'
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'Search timed out. Please try again.'
  }
  if (lower.includes('no webset id') || lower.includes('webset failed') || lower.includes('webset canceled') || lower.includes('webset timed out')) {
    return 'Search failed to start. Please try again.'
  }
  if (lower.includes('failed to get webset') || lower.includes('failed to cancel webset')) {
    return 'Search service is unreachable. Please try again.'
  }
  if (lower.includes('exa_api_key not configured')) {
    return 'Search service is not configured.'
  }
  if (lower.includes('no founders found')) return raw

  // Generic fallback — never leak upstream provider name/details
  return 'Search failed. Please try again.'
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
  await sql`
    DELETE FROM seed_founders a USING seed_founders b
    WHERE a.linkedin_url IS NOT NULL AND a.linkedin_url <> ''
      AND a.linkedin_url = b.linkedin_url
      AND a.created_at > b.created_at
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS seed_founders_linkedin_url_uidx
    ON seed_founders (linkedin_url)
    WHERE linkedin_url IS NOT NULL AND linkedin_url <> ''
  `
}

async function ensureSeedLpsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS seed_lps (
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
  await sql`ALTER TABLE seed_lps ADD COLUMN IF NOT EXISTS icp_score NUMERIC(5,1) DEFAULT 0`
  await sql`ALTER TABLE seed_lps ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'New'`
  await sql`
    DELETE FROM seed_lps a USING seed_lps b
    WHERE a.linkedin_url IS NOT NULL AND a.linkedin_url <> ''
      AND a.linkedin_url = b.linkedin_url
      AND a.created_at > b.created_at
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS seed_lps_linkedin_url_uidx
    ON seed_lps (linkedin_url)
    WHERE linkedin_url IS NOT NULL AND linkedin_url <> ''
  `
}

async function ensureSeedSearchesTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS seed_searches (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      webset_id      TEXT,
      query_text     TEXT,
      params_json    JSONB,
      status         TEXT DEFAULT 'running',
      results_count  INTEGER DEFAULT 0,
      error_message  TEXT,
      created_at     TIMESTAMPTZ DEFAULT now(),
      completed_at   TIMESTAMPTZ
    )
  `
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS webset_id TEXT`
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS query_text TEXT`
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS params_json JSONB`
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'`
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS results_count INTEGER DEFAULT 0`
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS error_message TEXT`
  await sql`ALTER TABLE seed_searches ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`
}

async function ensureSavedSearchTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS seed_saved_searches (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL,
      params_json JSONB NOT NULL,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS seed_saved_search_results (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      saved_search_id  UUID NOT NULL REFERENCES seed_saved_searches(id) ON DELETE CASCADE,
      session_id       UUID,
      run_at           TIMESTAMPTZ DEFAULT now(),
      results_json     JSONB NOT NULL DEFAULT '[]',
      results_count    INTEGER DEFAULT 0
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_saved_search_results_search_id ON seed_saved_search_results(saved_search_id)`
  await sql`ALTER TABLE seed_saved_search_results ADD COLUMN IF NOT EXISTS session_id UUID`
}

// ─── New staging tables ──────────────────────────────────────────────────────

async function ensureSeedSessionsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS seed_sessions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name            TEXT,
      source          TEXT NOT NULL DEFAULT 'adhoc',
      saved_search_id UUID,
      params_json     JSONB,
      status          TEXT DEFAULT 'running',
      results_count   INTEGER DEFAULT 0,
      webset_id       TEXT,
      error_message   TEXT,
      created_at      TIMESTAMPTZ DEFAULT now(),
      completed_at    TIMESTAMPTZ
    )
  `
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS name TEXT`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'adhoc'`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS saved_search_id UUID`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS params_json JSONB`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS results_count INTEGER DEFAULT 0`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS webset_id TEXT`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS error_message TEXT`
  await sql`ALTER TABLE seed_sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`
  await sql`CREATE INDEX IF NOT EXISTS idx_seed_sessions_source ON seed_sessions(source)`
  await sql`CREATE INDEX IF NOT EXISTS idx_seed_sessions_created_at ON seed_sessions(created_at DESC)`
}

async function ensureSeedSessionFoundersTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS seed_session_founders (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id    UUID NOT NULL,
      name          TEXT,
      linkedin_id   TEXT,
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
      created_at    TIMESTAMPTZ DEFAULT now()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_session_founders_session_id ON seed_session_founders(session_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_session_founders_linkedin_id ON seed_session_founders(linkedin_id) WHERE linkedin_id IS NOT NULL`
}

async function createSession({ name, source, savedSearchId, params, websetId }) {
  await ensureSeedSessionsTable()
  const rows = await sql`
    INSERT INTO seed_sessions (name, source, saved_search_id, params_json, webset_id, status)
    VALUES (
      ${name || null},
      ${source || 'adhoc'},
      ${savedSearchId || null},
      ${JSON.stringify(params || {})}::jsonb,
      ${websetId || null},
      'running'
    )
    RETURNING id
  `
  return rows[0]?.id
}

async function updateSession(id, updates = {}) {
  if (!id) return
  const { websetId, status, resultsCount, errorMessage, completed } = updates
  await sql`
    UPDATE seed_sessions SET
      webset_id     = COALESCE(${websetId ?? null}, webset_id),
      status        = COALESCE(${status ?? null}, status),
      results_count = COALESCE(${resultsCount ?? null}, results_count),
      error_message = COALESCE(${errorMessage ?? null}, error_message),
      completed_at  = CASE WHEN ${completed ?? false} THEN now() ELSE completed_at END
    WHERE id = ${id}
  `
}

async function bulkInsertSessionFounders(sessionId, rows) {
  if (!rows.length) return
  await ensureSeedSessionFoundersTable()
  // Insert in chunks of 50 to avoid huge queries
  const CHUNK = 50
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    for (const row of chunk) {
      try {
        await sql`
          INSERT INTO seed_session_founders
            (session_id, name, linkedin_id, linkedin_url, title, company_name,
             sector, background, location, stage, founded_year, summary, icp_score)
          VALUES (
            ${sessionId}, ${row.name || null}, ${row.linkedin_id || null},
            ${row.linkedin_url || null}, ${row.title || null}, ${row.company_name || null},
            ${row.sector || null}, ${row.background || null}, ${row.location || null},
            ${row.stage || null}, ${row.founded_year || null}, ${row.summary || null},
            ${row.icp_score ?? 0}
          )
        `
      } catch (e) {
        // Non-fatal — log and continue
        console.warn('[sessionFounders] insert error:', e.message)
      }
    }
  }
}

/**
 * After dedup, remove the duplicate rows from seed_session_founders so the
 * session view only shows net-new profiles.
 * keepRows = the deduped result array (what we want to keep).
 */
async function pruneSessionFounders(sessionId, keepRows) {
  if (!keepRows.length) {
    // Nothing to keep — delete everything in this session
    await sql`DELETE FROM seed_session_founders WHERE session_id = ${sessionId}`
    return
  }

  const keepIds  = keepRows.map(r => r.linkedin_id).filter(Boolean)
  const keepUrls = keepRows.map(r => r.linkedin_url).filter(Boolean)

  // Delete rows from this session that are NOT in the keep set
  // We identify "keep" rows by linkedin_id or linkedin_url
  if (!keepIds.length && !keepUrls.length) {
    // No identifiers to match — can't prune safely, keep everything
    console.warn('[pruneSessionFounders] No linkedin_id or linkedin_url in keepRows, skipping prune')
    return
  }

  let whereClause = ''
  const params = [sessionId]

  if (keepIds.length && keepUrls.length) {
    // Keep rows that match EITHER linkedin_id OR linkedin_url
    // Delete everything else
    const idPlaceholders  = keepIds.map((_, i) => `$${i + 2}`).join(', ')
    const urlPlaceholders = keepUrls.map((_, i) => `$${keepIds.length + i + 2}`).join(', ')
    whereClause = `NOT (
      (linkedin_id IS NOT NULL AND linkedin_id IN (${idPlaceholders})) OR
      (linkedin_url IS NOT NULL AND linkedin_url IN (${urlPlaceholders}))
    )`
    params.push(...keepIds, ...keepUrls)
  } else if (keepIds.length) {
    // Only have linkedin_ids to match
    const idPlaceholders = keepIds.map((_, i) => `$${i + 2}`).join(', ')
    whereClause = `NOT (linkedin_id IS NOT NULL AND linkedin_id IN (${idPlaceholders}))`
    params.push(...keepIds)
  } else {
    // Only have linkedin_urls to match
    const urlPlaceholders = keepUrls.map((_, i) => `$${i + 2}`).join(', ')
    whereClause = `NOT (linkedin_url IS NOT NULL AND linkedin_url IN (${urlPlaceholders}))`
    params.push(...keepUrls)
  }

  const result = await dbQuery(
    `DELETE FROM seed_session_founders WHERE session_id = $1 AND (${whereClause})`,
    params
  )
  console.log(`[pruneSessionFounders] Deleted ${result.rowCount} duplicate rows from session ${sessionId}`)
}

/**
 * Deduplicates a result set against:
 *   1. seed_founders + seed_lps (already curated contacts — always excluded)
 *   2. seed_session_founders from previous sessions of the same saved search
 *      (cross-run dedup — only when savedSearchId is provided)
 *
 * Returns the filtered array of rows that are genuinely new.
 */
async function deduplicateResults(results, { savedSearchId = null, currentSessionId = null } = {}) {
  if (!results.length) return results

  const ids  = results.map(r => r.linkedin_id).filter(Boolean)
  const urls = results.map(r => r.linkedin_url).filter(Boolean)

  const seenIds  = new Set()
  const seenUrls = new Set()

  // Option 3: exclude anyone already in seed_founders or seed_lps
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
    const { rows: founderIdRows } = await dbQuery(
      `SELECT linkedin_id FROM seed_founders WHERE linkedin_id IN (${placeholders})
       UNION
       SELECT linkedin_id FROM seed_lps WHERE linkedin_id IN (${placeholders})`,
      ids
    )
    founderIdRows.forEach(r => r.linkedin_id && seenIds.add(r.linkedin_id))
  }
  if (urls.length) {
    const placeholders = urls.map((_, i) => `$${i + 1}`).join(', ')
    const { rows: founderUrlRows } = await dbQuery(
      `SELECT linkedin_url FROM seed_founders WHERE linkedin_url IS NOT NULL AND linkedin_url IN (${placeholders})
       UNION
       SELECT linkedin_url FROM seed_lps WHERE linkedin_url IS NOT NULL AND linkedin_url IN (${placeholders})`,
      urls
    )
    founderUrlRows.forEach(r => r.linkedin_url && seenUrls.add(r.linkedin_url))
  }

  // Option 2: exclude anyone already seen in a previous session of the same saved search
  if (savedSearchId) {
    const sessionClause = currentSessionId ? `AND ss.id != $2` : ''

    if (ids.length) {
      const offset = currentSessionId ? 3 : 2
      const placeholders = ids.map((_, i) => `$${i + offset}`).join(', ')
      const params = currentSessionId
        ? [savedSearchId, currentSessionId, ...ids]
        : [savedSearchId, ...ids]
      const { rows: prevIdRows } = await dbQuery(
        `SELECT ssf.linkedin_id
         FROM seed_session_founders ssf
         JOIN seed_sessions ss ON ss.id = ssf.session_id
         WHERE ss.saved_search_id = $1
           ${sessionClause}
           AND ssf.linkedin_id IN (${placeholders})`,
        params
      )
      prevIdRows.forEach(r => r.linkedin_id && seenIds.add(r.linkedin_id))
    }
    if (urls.length) {
      const offset = currentSessionId ? 3 : 2
      const placeholders = urls.map((_, i) => `$${i + offset}`).join(', ')
      const params = currentSessionId
        ? [savedSearchId, currentSessionId, ...urls]
        : [savedSearchId, ...urls]
      const { rows: prevUrlRows } = await dbQuery(
        `SELECT ssf.linkedin_url
         FROM seed_session_founders ssf
         JOIN seed_sessions ss ON ss.id = ssf.session_id
         WHERE ss.saved_search_id = $1
           ${sessionClause}
           AND ssf.linkedin_url IS NOT NULL
           AND ssf.linkedin_url IN (${placeholders})`,
        params
      )
      prevUrlRows.forEach(r => r.linkedin_url && seenUrls.add(r.linkedin_url))
    }
  }

  const filtered = results.filter(r =>
    (!r.linkedin_id  || !seenIds.has(r.linkedin_id)) &&
    (!r.linkedin_url || !seenUrls.has(r.linkedin_url))
  )

  const removed = results.length - filtered.length
  if (removed > 0) {
    console.log(`[dedup] removed ${removed} duplicate(s) from ${results.length} results`)
  }

  return filtered
}

async function createSearchLog({ query, params }) {
  const rows = await sql`
    INSERT INTO seed_searches (query_text, params_json, status)
    VALUES (${query}, ${JSON.stringify(params || {})}::jsonb, 'running')
    RETURNING id
  `
  return rows[0]?.id
}

async function updateSearchLog(id, updates = {}) {
  if (!id) return
  const {
    websetId = null,
    status = null,
    resultsCount = null,
    errorMessage = null,
    completed = false
  } = updates

  await sql`
    UPDATE seed_searches
    SET
      webset_id = COALESCE(${websetId}, webset_id),
      status = COALESCE(${status}, status),
      results_count = COALESCE(${resultsCount}, results_count),
      error_message = COALESCE(${errorMessage}, error_message),
      completed_at = CASE WHEN ${completed} THEN now() ELSE completed_at END
    WHERE id = ${id}
  `
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

async function cancelWebset(websetId) {
  const res = await fetch(`${WEBSETS_API_URL}/${websetId}/cancel`, {
    method: 'POST',
    headers: { 'x-api-key': EXA_API_KEY }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to cancel webset (${res.status}): ${text}`)
  }
  return res.json().catch(() => ({ ok: true }))
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

async function streamWebsetWithAdaptivePolling(websetId, params, onEvent, shouldCancel, onNewBatch) {
  const start = Date.now()
  const seenKeys = new Set()
  const normalizedRows = []
  let transientFailures = 0
  let lastStatus = 'starting'

  while (Date.now() - start < MAX_WEBSET_WAIT_MS) {
    if (shouldCancel()) throw new Error('Seeding cancelled by user')
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
      // Non-blocking DB write for new batch rows
      if (onNewBatch) {
        onNewBatch(newlyFound).catch(e => console.warn('[poll] onNewBatch error:', e.message))
      }
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

function normalizeLinkedinUrl(url = '') {
  if (!url) return ''
  try {
    const u = new URL(url.trim())
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    const path = u.pathname.replace(/\/+$/, '').toLowerCase()
    return `https://${host}${path}`
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '')
  }
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
  const normalizedUrl = normalizeLinkedinUrl(row.linkedin_url || '')
  const urlForInsert = normalizedUrl || null

  if (row.linkedin_id) {
    const inserted = await sql`
      INSERT INTO seed_founders (name, linkedin_id, linkedin_url, title, company_name,
        sector, background, location, stage, founded_year, summary, icp_score, status)
      VALUES (${row.name}, ${row.linkedin_id}, ${urlForInsert}, ${row.title}, ${row.company_name},
        ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
        ${row.summary}, ${row.icp_score}, 'New')
      ON CONFLICT (linkedin_id) DO NOTHING
      RETURNING id
    `
    return inserted.length ? 'added' : 'duplicate'
  }

  if (normalizedUrl) {
    const inserted = await sql`
      INSERT INTO seed_founders (name, linkedin_id, linkedin_url, title, company_name,
        sector, background, location, stage, founded_year, summary, icp_score, status)
      VALUES (${row.name}, ${null}, ${normalizedUrl}, ${row.title}, ${row.company_name},
        ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
        ${row.summary}, ${row.icp_score}, 'New')
      ON CONFLICT (linkedin_url) WHERE linkedin_url IS NOT NULL AND linkedin_url <> '' DO NOTHING
      RETURNING id
    `
    return inserted.length ? 'added' : 'duplicate'
  }

  await sql`
    INSERT INTO seed_founders (name, linkedin_id, linkedin_url, title, company_name,
      sector, background, location, stage, founded_year, summary, icp_score, status)
    VALUES (${row.name}, ${null}, ${null}, ${row.title}, ${row.company_name},
      ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
      ${row.summary}, ${row.icp_score}, 'New')
  `
  return 'added'
}

async function upsertLp(row) {
  const normalizedUrl = normalizeLinkedinUrl(row.linkedin_url || '')
  const urlForInsert = normalizedUrl || null

  if (row.linkedin_id) {
    const inserted = await sql`
      INSERT INTO seed_lps (name, linkedin_id, linkedin_url, title, company_name,
        sector, background, location, stage, founded_year, summary, icp_score, status)
      VALUES (${row.name}, ${row.linkedin_id}, ${urlForInsert}, ${row.title}, ${row.company_name},
        ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
        ${row.summary}, ${row.icp_score}, 'New')
      ON CONFLICT (linkedin_id) DO NOTHING
      RETURNING id
    `
    return inserted.length ? 'added' : 'duplicate'
  }

  if (normalizedUrl) {
    const inserted = await sql`
      INSERT INTO seed_lps (name, linkedin_id, linkedin_url, title, company_name,
        sector, background, location, stage, founded_year, summary, icp_score, status)
      VALUES (${row.name}, ${null}, ${normalizedUrl}, ${row.title}, ${row.company_name},
        ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
        ${row.summary}, ${row.icp_score}, 'New')
      ON CONFLICT (linkedin_url) WHERE linkedin_url IS NOT NULL AND linkedin_url <> '' DO NOTHING
      RETURNING id
    `
    return inserted.length ? 'added' : 'duplicate'
  }

  await sql`
    INSERT INTO seed_lps (name, linkedin_id, linkedin_url, title, company_name,
      sector, background, location, stage, founded_year, summary, icp_score, status)
    VALUES (${row.name}, ${null}, ${null}, ${row.title}, ${row.company_name},
      ${row.sector}, ${row.background}, ${row.location}, ${row.stage}, ${row.founded_year},
      ${row.summary}, ${row.icp_score}, 'New')
  `
  return 'added'
}

// ─── POST /seed-founders/search ─────────────────────────────────────────────
router.post('/search', async (req, res) => {
  let activeWebsetId = null
  let searchLogId = null
  let sessionId = null
  try {
    if (!EXA_API_KEY) throw new Error('EXA_API_KEY not configured')

    await ensureSeedFoundersTable()
    await ensureSeedSearchesTable()
    await ensureSeedSessionsTable()
    await ensureSeedSessionFoundersTable()

    const params = req.body
    const count = Math.min(params.count || 50, 100)
    
    const query = buildQuery(params)
    const criteria = buildCriteria(params)
    searchLogId = await createSearchLog({ query, params })

    // Build a human-readable session name from the query params
    const sessionName = (params.query?.trim()) ||
      [params.stage, ...(params.sectors || []), ...(params.backgrounds || []).slice(0, 2)]
        .filter(Boolean).join(', ') ||
      'Founder search'

    console.log(`[seedFounders] webset search: "${query}" (n=${count})`)

    res.writeHead(200, SSE_HEADERS)
    res.flushHeaders?.()

    const websetId = await createWebset(query, criteria, count)
    activeWebsetId = websetId
    await updateSearchLog(searchLogId, { websetId })
    canceledWebsets.delete(websetId)

    // Create session record now that we have the webset ID
    sessionId = await createSession({ name: sessionName, source: 'adhoc', params, websetId })

    emitSse(res, 'ready', {
      websetId,
      sessionId,
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
        fields: ['success', 'total', 'results', 'sessionId', 'message']
      }
    })

    const rawResults = await streamWebsetWithAdaptivePolling(
      websetId,
      params,
      (event, payload) => {
        emitSse(res, event, payload)
      },
      () => canceledWebsets.has(websetId),
      // onNewBatch: persist each batch to seed_session_founders as it arrives
      (newRows) => bulkInsertSessionFounders(sessionId, newRows)
    )

    // Dedup against seed_founders + seed_lps (Option 3)
    const results = await deduplicateResults(rawResults, { currentSessionId: sessionId })

    // Remove duplicate rows from seed_session_founders so the session view is clean
    await pruneSessionFounders(sessionId, results).catch(e =>
      console.warn('[search] pruneSessionFounders error:', e.message)
    )

    if (!results.length) {
      await updateSearchLog(searchLogId, { status: 'completed', resultsCount: 0, completed: true })
      await updateSession(sessionId, { status: 'completed', resultsCount: 0, completed: true })
      emitSse(res, 'done', { success: false, sessionId, message: 'No new founders found. Try broader search.' })
      return res.end()
    }

    await updateSearchLog(searchLogId, { status: 'completed', resultsCount: results.length, completed: true })
    await updateSession(sessionId, { status: 'completed', resultsCount: results.length, completed: true })

    emitSse(res, 'done', {
      success: true,
      total: results.length,
      sessionId,
      results: results.sort((a, b) => b.icp_score - a.icp_score),
      message: `Found ${results.length} founders`
    })
    canceledWebsets.delete(websetId)
    return res.end()
  } catch (err) {
    console.error('[seedFounders] search error:', err)
    const safeMessage = sanitizeErrorMessage(err)
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: safeMessage })
    }
    if (err.message === 'Seeding cancelled by user') {
      if (activeWebsetId) canceledWebsets.delete(activeWebsetId)
      await updateSearchLog(searchLogId, { status: 'cancelled', completed: true })
      if (sessionId) await updateSession(sessionId, { status: 'cancelled', completed: true })
      emitSse(res, 'done', { success: false, cancelled: true, sessionId, message: 'Seeding stopped by user' })
      return res.end()
    }
    if (activeWebsetId) canceledWebsets.delete(activeWebsetId)
    await updateSearchLog(searchLogId, { status: 'failed', errorMessage: safeMessage, completed: true })
    if (sessionId) await updateSession(sessionId, { status: 'failed', errorMessage: safeMessage, completed: true })
    emitSse(res, 'error', { success: false, message: safeMessage })
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
    return res.status(500).json({ success: false, message: sanitizeErrorMessage(err) })
  }
})

router.post('/save-lps-batch', async (req, res) => {
  try {
    await ensureSeedLpsTable()
    const { lps = [] } = req.body
    let added = 0, duplicates = 0

    for (const row of lps) {
      try {
        const outcome = await upsertLp(row)
        if (outcome === 'added') added++; else duplicates++
      } catch (e) {
        if (e.code === '23505') duplicates++
        else console.error('[seedFounders] lp batch insert error:', e.message)
      }
    }

    return res.json({ success: true, added, duplicates })
  } catch (err) {
    console.error('[seedFounders] save-lps-batch error:', err)
    return res.status(500).json({ success: false, message: sanitizeErrorMessage(err) })
  }
})

router.get('/lps', async (req, res) => {
  try {
    await ensureSeedLpsTable()
    const { search, limit = 200, offset = 0 } = req.query
    const q = search ? `%${search}%` : null

    let rows
    if (q) {
      rows = await sql`SELECT * FROM seed_lps WHERE name ILIKE ${q} OR company_name ILIKE ${q} OR title ILIKE ${q} ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    } else {
      rows = await sql`SELECT * FROM seed_lps ORDER BY icp_score DESC, created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    }

    return res.json({ lps: rows })
  } catch (err) {
    console.error('[seedFounders] list lps error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

router.get('/recent-searches', async (req, res) => {
  try {
    await ensureSeedSearchesTable()
    const { limit = 50, offset = 0 } = req.query
    const rows = await sql`
      SELECT id, webset_id, query_text, status, results_count, error_message, created_at, completed_at
      FROM seed_searches
      ORDER BY created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `
    const safeRows = rows.map((r) => ({
      ...r,
      error_message: r.error_message ? sanitizeErrorMessage(r.error_message) : r.error_message
    }))
    return res.json({ searches: safeRows })
  } catch (err) {
    console.error('[seedFounders] recent searches error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

router.post('/search/cancel', async (req, res) => {
  try {
    if (!EXA_API_KEY) throw new Error('EXA_API_KEY not configured')
    const { websetId } = req.body || {}
    if (!websetId) return res.status(400).json({ success: false, message: 'websetId is required' })

    canceledWebsets.add(websetId)
    let upstream = null
    try {
      upstream = await cancelWebset(websetId)
    } catch (err) {
      console.error('[seedFounders] cancel upstream error:', err)
      upstream = { ok: false, message: sanitizeErrorMessage(err) }
    }
    return res.json({ success: true, cancelled: true, websetId, upstream })
  } catch (err) {
    return res.status(500).json({ success: false, message: sanitizeErrorMessage(err) })
  }
})

// ─── GET /seed-founders/sessions ────────────────────────────────────────────
router.get('/sessions', async (req, res) => {
  try {
    await ensureSeedSessionsTable()
    const { source, limit = 50, offset = 0 } = req.query
    let rows
    if (source && source !== 'all') {
      rows = await sql`
        SELECT * FROM seed_sessions
        WHERE source = ${source}
        ORDER BY created_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `
    } else {
      rows = await sql`
        SELECT * FROM seed_sessions
        ORDER BY created_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `
    }
    const safeRows = rows.map(r => ({
      ...r,
      error_message: r.error_message ? sanitizeErrorMessage(r.error_message) : r.error_message
    }))
    return res.json({ sessions: safeRows })
  } catch (err) {
    console.error('[sessions] list error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// ─── GET /seed-founders/sessions/:sessionId/founders ────────────────────────
router.get('/sessions/:sessionId/founders', async (req, res) => {
  try {
    await ensureSeedSessionsTable()
    await ensureSeedSessionFoundersTable()
    const { sessionId } = req.params
    const { search, limit = 200, offset = 0 } = req.query

    const sessionRows = await sql`SELECT * FROM seed_sessions WHERE id = ${sessionId} LIMIT 1`
    if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' })

    const q = search ? `%${search}%` : null
    let founders
    if (q) {
      founders = await sql`
        SELECT * FROM seed_session_founders
        WHERE session_id = ${sessionId}
          AND (name ILIKE ${q} OR company_name ILIKE ${q} OR title ILIKE ${q} OR location ILIKE ${q})
        ORDER BY icp_score DESC, created_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `
    } else {
      founders = await sql`
        SELECT * FROM seed_session_founders
        WHERE session_id = ${sessionId}
        ORDER BY icp_score DESC, created_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `
    }

    return res.json({ founders, session: sessionRows[0], total: founders.length })
  } catch (err) {
    console.error('[sessions] founders error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
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
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
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
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// ─── DELETE /seed-founders/:id ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await sql`DELETE FROM seed_founders WHERE id = ${req.params.id}`
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

router.delete('/lps/:id', async (req, res) => {
  try {
    await ensureSeedLpsTable()
    await sql`DELETE FROM seed_lps WHERE id = ${req.params.id}`
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// ─── Saved Searches ──────────────────────────────────────────────────────────

export async function runSavedSearch(savedSearchId) {
  await ensureSavedSearchTables()
  await ensureSeedSessionsTable()
  await ensureSeedSessionFoundersTable()

  const rows = await sql`SELECT * FROM seed_saved_searches WHERE id = ${savedSearchId} LIMIT 1`
  const saved = rows[0]
  if (!saved) throw new Error('Saved search not found')

  const params = saved.params_json || {}
  const count = Math.min(params.count || 50, 100)
  const query = buildQuery(params)
  const criteria = buildCriteria(params)

  console.log(`[savedSearch] running "${saved.name}" (id=${savedSearchId})`)

  const websetId = await createWebset(query, criteria, count)
  canceledWebsets.delete(websetId)

  const sessionId = await createSession({
    name: saved.name,
    source: 'saved_search',
    savedSearchId,
    params,
    websetId
  })

  const rawResults = await streamWebsetWithAdaptivePolling(
    websetId, params, () => {}, () => false,
    (newRows) => bulkInsertSessionFounders(sessionId, newRows)
  )

  // Dedup: exclude already-saved contacts (Option 3) + previous runs of this saved search (Option 2)
  const results = await deduplicateResults(rawResults, {
    savedSearchId,
    currentSessionId: sessionId
  })

  // Remove duplicate rows from seed_session_founders so the session view is clean
  await pruneSessionFounders(sessionId, results).catch(e =>
    console.warn('[savedSearch cron] pruneSessionFounders error:', e.message)
  )

  const resultRow = await sql`
    INSERT INTO seed_saved_search_results (saved_search_id, session_id, results_json, results_count)
    VALUES (${savedSearchId}, ${sessionId}, ${JSON.stringify(results)}::jsonb, ${results.length})
    RETURNING id
  `

  const nextRun = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await sql`
    UPDATE seed_saved_searches
    SET last_run_at = now(), next_run_at = ${nextRun.toISOString()}
    WHERE id = ${savedSearchId}
  `

  await updateSession(sessionId, { status: 'completed', resultsCount: results.length, completed: true })

  console.log(`[savedSearch] done "${saved.name}" — ${results.length} results, next run ${nextRun.toISOString()}`)
  return { resultId: resultRow[0]?.id, sessionId, count: results.length }
}

// POST /seed-founders/saved-searches
router.post('/saved-searches', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    const { name, params } = req.body || {}
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
    if (!params || typeof params !== 'object') return res.status(400).json({ error: 'params is required' })

    const nextRun = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const rows = await sql`
      INSERT INTO seed_saved_searches (name, params_json, next_run_at)
      VALUES (${name.trim()}, ${JSON.stringify(params)}::jsonb, ${nextRun.toISOString()})
      RETURNING *
    `
    return res.status(201).json(rows[0])
  } catch (err) {
    console.error('[savedSearch] create error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// GET /seed-founders/saved-searches
router.get('/saved-searches', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    const rows = await sql`
      SELECT ss.*, COUNT(ssr.id)::int AS run_count
      FROM seed_saved_searches ss
      LEFT JOIN seed_saved_search_results ssr ON ssr.saved_search_id = ss.id
      GROUP BY ss.id
      ORDER BY ss.created_at DESC
    `
    return res.json({ savedSearches: rows })
  } catch (err) {
    console.error('[savedSearch] list error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// PATCH /seed-founders/saved-searches/:id
router.patch('/saved-searches/:id', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    const { name } = req.body || {}
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
    const rows = await sql`
      UPDATE seed_saved_searches SET name = ${name.trim()} WHERE id = ${req.params.id} RETURNING *
    `
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    return res.json(rows[0])
  } catch (err) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// DELETE /seed-founders/saved-searches/:id
router.delete('/saved-searches/:id', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    await sql`DELETE FROM seed_saved_searches WHERE id = ${req.params.id}`
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// GET /seed-founders/saved-searches/:id/results
router.get('/saved-searches/:id/results', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    const { id } = req.params
    const { limit = 10, offset = 0 } = req.query

    const savedRows = await sql`SELECT * FROM seed_saved_searches WHERE id = ${id} LIMIT 1`
    if (!savedRows[0]) return res.status(404).json({ error: 'Saved search not found' })

    const runs = await sql`
      SELECT id, run_at, results_count
      FROM seed_saved_search_results
      WHERE saved_search_id = ${id}
      ORDER BY run_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `
    return res.json({ savedSearch: savedRows[0], runs })
  } catch (err) {
    console.error('[savedSearch] results error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// GET /seed-founders/saved-searches/:id/results/:runId
router.get('/saved-searches/:id/results/:runId', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    const { id, runId } = req.params
    const rows = await sql`
      SELECT * FROM seed_saved_search_results
      WHERE id = ${runId} AND saved_search_id = ${id}
      LIMIT 1
    `
    if (!rows[0]) return res.status(404).json({ error: 'Run not found' })
    return res.json({ run: rows[0] })
  } catch (err) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// POST /seed-founders/saved-searches/:id/runs  (store results from a frontend search directly)
router.post('/saved-searches/:id/runs', async (req, res) => {
  try {
    await ensureSavedSearchTables()
    const { id } = req.params
    const { results = [], runId = null } = req.body || {}

    const savedRows = await sql`SELECT id FROM seed_saved_searches WHERE id = ${id} LIMIT 1`
    if (!savedRows[0]) return res.status(404).json({ error: 'Saved search not found' })

    let row
    if (runId) {
      // Update existing run in-place
      const updated = await sql`
        UPDATE seed_saved_search_results
        SET results_json = ${JSON.stringify(results)}::jsonb, results_count = ${results.length}
        WHERE id = ${runId} AND saved_search_id = ${id}
        RETURNING id, run_at, results_count
      `
      row = updated[0]
    }

    if (!row) {
      // Insert new run
      const inserted = await sql`
        INSERT INTO seed_saved_search_results (saved_search_id, results_json, results_count)
        VALUES (${id}, ${JSON.stringify(results)}::jsonb, ${results.length})
        RETURNING id, run_at, results_count
      `
      row = inserted[0]
    }

    await sql`
      UPDATE seed_saved_searches
      SET last_run_at = now(),
          next_run_at = ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
      WHERE id = ${id}
    `
    return res.status(201).json(row)
  } catch (err) {
    console.error('[savedSearch] store run error:', err)
    return res.status(500).json({ error: sanitizeErrorMessage(err) })
  }
})

// POST /seed-founders/saved-searches/:id/run  (manual trigger with SSE streaming)
router.post('/saved-searches/:id/run', async (req, res) => {
  let activeWebsetId = null
  let sessionId = null
  try {
    if (!EXA_API_KEY) throw new Error('EXA_API_KEY not configured')
    await ensureSavedSearchTables()
    await ensureSeedSessionsTable()
    await ensureSeedSessionFoundersTable()
    
    const rows = await sql`SELECT * FROM seed_saved_searches WHERE id = ${req.params.id} LIMIT 1`
    const saved = rows[0]
    if (!saved) return res.status(404).json({ error: 'Saved search not found' })

    const params = saved.params_json || {}
    const count = Math.min(params.count || 50, 100)
    const query = buildQuery(params)
    const criteria = buildCriteria(params)

    console.log(`[savedSearch] running "${saved.name}" (id=${req.params.id})`)

    // Start SSE streaming
    res.writeHead(200, SSE_HEADERS)
    res.flushHeaders?.()

    const websetId = await createWebset(query, criteria, count)
    activeWebsetId = websetId
    canceledWebsets.delete(websetId)

    // Create session for this run
    sessionId = await createSession({
      name: saved.name,
      source: 'saved_search',
      savedSearchId: req.params.id,
      params,
      websetId
    })
    
    emitSse(res, 'ready', {
      websetId,
      sessionId,
      message: `Running "${saved.name}"...`
    })

    const rawResults = await streamWebsetWithAdaptivePolling(
      websetId,
      params,
      (event, payload) => {
        emitSse(res, event, payload)
      },
      () => canceledWebsets.has(websetId),
      // onNewBatch: persist each batch to seed_session_founders as it arrives
      (newRows) => bulkInsertSessionFounders(sessionId, newRows)
    )

    // Dedup: exclude already-saved contacts (Option 3) + previous runs of this saved search (Option 2)
    const results = await deduplicateResults(rawResults, {
      savedSearchId: req.params.id,
      currentSessionId: sessionId
    })

    // Remove duplicate rows from seed_session_founders so the session view is clean
    await pruneSessionFounders(sessionId, results).catch(e =>
      console.warn('[savedSearch] pruneSessionFounders error:', e.message)
    )

    // Store run snapshot (keep existing behaviour for backward compat)
    const resultRow = await sql`
      INSERT INTO seed_saved_search_results (saved_search_id, session_id, results_json, results_count)
      VALUES (${req.params.id}, ${sessionId}, ${JSON.stringify(results)}::jsonb, ${results.length})
      RETURNING id
    `

    const nextRun = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await sql`
      UPDATE seed_saved_searches
      SET last_run_at = now(), next_run_at = ${nextRun.toISOString()}
      WHERE id = ${req.params.id}
    `

    await updateSession(sessionId, { status: 'completed', resultsCount: results.length, completed: true })

    console.log(`[savedSearch] done "${saved.name}" — ${results.length} results (after dedup)`)
    
    emitSse(res, 'done', {
      success: true,
      resultId: resultRow[0]?.id,
      sessionId,
      count: results.length,
      message: `Found ${results.length} results`
    })
    
    canceledWebsets.delete(websetId)
    return res.end()
  } catch (err) {
    console.error('[savedSearch] manual run error:', err)
    const safeMessage = sanitizeErrorMessage(err)
    if (!res.headersSent) {
      return res.status(500).json({ error: safeMessage })
    }
    if (activeWebsetId) canceledWebsets.delete(activeWebsetId)
    if (sessionId) await updateSession(sessionId, { status: 'failed', errorMessage: safeMessage, completed: true }).catch(() => {})
    emitSse(res, 'error', { success: false, message: safeMessage })
    return res.end()
  }
})

export default router
