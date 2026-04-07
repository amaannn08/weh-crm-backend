/**
 * sheetQueryTool.js
 *
 * Fetches the WEH Ventures deal-tracking Google Sheet via the Sheets REST API
 * directly, using the OAuth2 access token stored in google-token.json.
 * If the token is expired, it automatically refreshes it via the token endpoint.
 *
 * The spreadsheet has 4 named tabs:
 *   Sheet1            — Deal evaluations
 *   Outbound Contacts — Outreach log
 *   Referrals         — Referral tracking
 *   Team meetings     — Team meeting notes
 *
 * Sheet data is cached for 5 minutes.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'

const SPREADSHEET_ID = '1Nosp-GCCPp3gZJ3NM1JwPjHfknFCS8Ir7c3MuevuFhQ'

const TABS = [
  'Sheet1',
  'Outbound Contacts',
  'Referrals',
  'Team meetings',
]

// ─── In-memory cache (5-minute TTL) ─────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000
const _cache = { data: null, fetchedAt: 0 }

// ─── Token management ────────────────────────────────────────────────────────
function loadTokens() {
  const tokenPath = join(process.cwd(), process.env.GOOGLE_TOKEN_PATH || 'google-token.json')
  if (!existsSync(tokenPath)) throw new Error('google-token.json not found')
  return { tokens: JSON.parse(readFileSync(tokenPath, 'utf8')), tokenPath }
}

function saveTokens(tokenPath, tokens) {
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2))
  console.log('[sheetQueryTool] Refreshed tokens saved')
}

async function getValidAccessToken() {
  const { tokens, tokenPath } = loadTokens()

  // Check if current access_token is still valid (with 60s buffer)
  const now = Date.now()
  if (tokens.access_token && tokens.expiry_date && (tokens.expiry_date - now) > 60_000) {
    return tokens.access_token
  }

  // Refresh using the refresh_token
  const CLIENT_ID     = process.env.CLIENT_ID
  const CLIENT_SECRET = process.env.CLIENT_SECRET
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('CLIENT_ID / CLIENT_SECRET not set')
  if (!tokens.refresh_token) throw new Error('No refresh_token in google-token.json — please re-run authorizeGoogleDrive.js')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type:    'refresh_token'
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const refreshed = await res.json()
  const merged = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date:  Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {})
  }
  saveTokens(tokenPath, merged)
  return merged.access_token
}

// ─── Sheets REST API fetch ───────────────────────────────────────────────────
async function fetchSheetRange(accessToken, range) {
  const encodedRange = encodeURIComponent(range)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodedRange}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Sheets API error for "${range}" (${res.status}): ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  return json.values ?? []   // array of arrays
}

// ─── Convert grid (array-of-arrays) to array-of-objects ─────────────────────
function gridToObjects(rows) {
  if (!rows || rows.length < 2) return []
  const headers = rows[0].map(h => String(h ?? '').replace(/\s+/g, ' ').trim())
  return rows.slice(1)
    .filter(r => r.some(c => c != null && c !== ''))
    .map(r => {
      const obj = {}
      headers.forEach((h, i) => { if (h) obj[h] = r[i] != null ? String(r[i]) : '' })
      return obj
    })
}

// ─── Load all tabs (with caching) ───────────────────────────────────────────
async function loadAllTabs() {
  const now = Date.now()
  if (_cache.data && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.data
  }

  const accessToken = await getValidAccessToken()
  const results = {}

  for (const tab of TABS) {
    try {
      const grid = await fetchSheetRange(accessToken, tab)
      results[tab] = gridToObjects(grid)
      console.log(`[sheetQueryTool] Loaded "${tab}": ${results[tab].length} rows`)
    } catch (err) {
      console.warn(`[sheetQueryTool] Could not load "${tab}": ${err.message}`)
      results[tab] = []
    }
  }

  _cache.data      = results
  _cache.fetchedAt = now
  return results
}

// ─── Format tab data for LLM ────────────────────────────────────────────────
function formatTabAsText(tabName, records, limit = 300) {
  if (!records || records.length === 0) return `[${tabName}]: No data available.\n`
  const headers = Object.keys(records[0])
  const sample  = records.slice(0, limit)
  const lines   = sample.map(r =>
    headers.map(h => `${h}: ${r[h] || '—'}`).join(' | ')
  )
  return `[${tabName}] (${records.length} total rows):\n` + lines.join('\n') + '\n'
}

// ─── Auto-detect which tabs to surface ──────────────────────────────────────
// Sheet structure:
//   Sheet1          = Inbound contacts (Name, Industry, Description, Logged By, Notes)
//   Outbound Contacts = Outbound contact log (Date, Name, Company Name, Industry, Description, Logged By, Reverted?, Email, Remarks)
//   Referrals       = Referral tracking (Date, Name, Company Name, Industry, Direction, Logged By, Reverted?, Email, Remarks, Priority)
//   Team meetings   = Deal pipeline evaluations (Company, Date, POC, Sector, Status, Why exciting, Risks, Conviction Score, Reasons for Pass, Reasons to watch, Action required)
function selectRelevantTabs(query) {
  const q = query.toLowerCase()

  // Team meetings tab = deal evaluations / pipeline
  const dealKw     = ['conviction', 'score', 'pass', 'watch', 'exciting', 'risk', 'action required',
                      'sector', 'poc', 'status', 'pipeline', 'deal', 'portfolio', 'ic ', 'track',
                      'founder watch', 'team meeting']
  // Outbound tab
  const outboundKw = ['outbound', 'outreach']
  // Referrals tab
  const referralKw = ['referral', 'referred', 'direction', 'inbound from', 'priority', 'whatsapp']
  // Sheet1 = inbound contacts
  const inboundKw  = ['inbound contact', 'inbound lead', 'sheet1', 'logged by', 'notes']

  if (dealKw.some(k => q.includes(k)))     return ['Team meetings']
  if (outboundKw.some(k => q.includes(k))) return ['Outbound Contacts']
  if (referralKw.some(k => q.includes(k))) return ['Referrals']
  if (inboundKw.some(k => q.includes(k)))  return ['Sheet1']

  // Default for company-specific or generic sheet questions: check Team meetings first
  return ['Team meetings']
}

function filterByCompany(records, company) {
  if (!company) return records
  const c = company.toLowerCase()
  return records.filter(r =>
    Object.values(r).some(v => typeof v === 'string' && v.toLowerCase().includes(c))
  )
}

// ─── Tool export ─────────────────────────────────────────────────────────────
export const sheetQueryTool = {
  id: 'sheet_query',
  description:
    'Queries the WEH Ventures deal-tracking Google Sheet. The sheet has 4 tabs:\n' +
    '(1) "Team meetings" tab — THIS IS THE MAIN DEAL PIPELINE/EVALUATION SHEET. Columns: Company, Date, POC, Sector, Status (Pass/IC/Track/Founder watch), "Why is this exciting?", Risks, "Conviction Score (on 10)", "Reasons for Pass", "Reasons to watch", "Action required". Use for deal status, conviction scores, pass/watch reasons, portfolio questions.\n' +
    '(2) "Outbound Contacts" tab — Outbound outreach log. Columns: Date, Name, Company Name, Industry, Description, Logged By, Reverted?, Email, Remarks, Team Meeting.\n' +
    '(3) "Referrals" tab — Referral tracking. Columns: Date, Name, Company Name, Industry, Description, Direction (Inbound/Outbound), Logged By, Reverted?, Email, Remarks, Priority, Team Meeting.\n' +
    '(4) "Sheet1" tab — Inbound contacts log. Columns: Name, Industry, Description, Logged By, Team Meeting, Notes.\n' +
    'Use this tool when the user asks about: conviction scores, deal statuses, pass/watch reasons, POC, outbound contacts, referrals, or anything from "the sheet".',
  inputSchema: {
    type: 'object',
    properties: {
      query:   { type: 'string', description: "The user's question to answer from the sheet" },
      company: { type: 'string', description: 'Optional: filter to rows mentioning this company' },
      tab:     { type: 'string', description: 'Optional: "Sheet1", "Outbound Contacts", "Referrals", or "Team meetings". Leave blank for auto-detect.' }
    },
    required: ['query']
  },

  async execute({ input }) {
    const query   = input?.query   ?? ''
    const company = input?.company ?? null
    const tabHint = input?.tab     ?? null

    let allData
    try {
      allData = await loadAllTabs()
    } catch (err) {
      console.error('[sheetQueryTool] Failed to load sheet:', err.message)
      return { sheetContext: `Failed to load sheet data: ${err.message}` }
    }

    const tabsToShow = (tabHint && allData[tabHint])
      ? [tabHint]
      : selectRelevantTabs(query)

    let sheetContext = ''
    for (const tabName of tabsToShow) {
      let records = allData[tabName] ?? []
      if (company) records = filterByCompany(records, company)
      sheetContext += formatTabAsText(tabName, records) + '\n'
    }

    return { sheetContext: sheetContext.trim() || 'No relevant sheet data found.' }
  }
}
