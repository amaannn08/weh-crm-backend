/**
 * sheetQueryTool.js
 *
 * The LLM acts as the query planner — it picks the tab and filters.
 * This tool spawns sheet_query.py (Python) which fetches and filters the
 * raw Google Sheets data with proper date parsing, returning clean JSON.
 *
 * Tab schemas:
 *   Sheet1            — Inbound contacts  (Timestamp, Name, Industry, Description, Logged By, Team Meeting, Notes)
 *   Outbound Contacts — Outbound outreach (Date, Name, Company Name, Industry, Description, Logged By, Reverted?, Email, Remarks, Team Meeting)
 *   Referrals         — Referral tracking (Date, Name, Company Name, Industry, Description, Direction, Logged By, Reverted?, Email, Remarks, Priority, Team Meeting)
 *   Team meetings     — Deal pipeline     (Company, Date, POC, Sector, Status, Why is this exciting?, Risks, Conviction Score (on 10), Reasons for Pass, Reasons to watch, Action required)
 */

import { execFile } from 'child_process'
import { join } from 'path'

// ─── Python runner ────────────────────────────────────────────────────────────

async function runPythonQuery({ tab, filterMonth, filterYear, filterKeyword, limit = 500 }) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'sheet_query.py')
    const args = ['--tab', tab]
    if (filterMonth)   args.push('--filter-month',   filterMonth)
    if (filterYear)    args.push('--filter-year',    String(filterYear))
    if (filterKeyword) args.push('--filter-keyword', filterKeyword)
    args.push('--limit', String(limit))

    execFile('python3', [scriptPath, ...args], {
      cwd:       process.cwd(),
      env:       process.env,   // pass CLIENT_ID, CLIENT_SECRET, GOOGLE_TOKEN_PATH through
      timeout:   30_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('[sheetQueryTool] Python stderr:', stderr?.slice(0, 500))
        reject(new Error(`Python query failed: ${err.message}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (e) {
        reject(new Error(`Could not parse Python output: ${stdout.slice(0, 300)}`))
      }
    })
  })
}

// ─── Format Python result for LLM ────────────────────────────────────────────

const MAX_ROWS_FOR_LLM = 50   // cap to avoid context overload / hallucination

// Columns to skip per tab — noisy or always-same-value fields
const TAB_SKIP_COLUMNS = {
  'Sheet1': new Set(['Team Meeting']),  // always "No"
}

// Human-readable label per tab so the LLM understands what it's looking at
const TAB_LABELS = {
  'Sheet1':            'INBOUND CONTACTS LOG (Sheet1)',
  'Outbound Contacts': 'OUTBOUND CONTACTS LOG',
  'Referrals':         'REFERRALS LOG',
  'Team meetings':     'DEAL PIPELINE EVALUATIONS (Team meetings)',
}

function formatRowsForLLM(result) {
  const { tab, total_rows, filtered_count, year_breakdown, columns, rows } = result
  const tabLabel = TAB_LABELS[tab] ?? tab

  if (!rows || rows.length === 0) {
    return (
      `[${tabLabel}]: No data found matching the given filters.\n` +
      `(Tab has ${total_rows} total rows — try broader filters or check the tab name.)`
    )
  }

  // Build a clear summary the LLM can use to answer count questions immediately
  const displayRows = rows.slice(0, MAX_ROWS_FOR_LLM)
  const truncated = rows.length > MAX_ROWS_FOR_LLM

  let summary =
    `[${tabLabel}]\n` +
    `TOTAL ROWS IN TAB: ${total_rows}\n` +
    `ROWS MATCHING FILTERS: ${filtered_count}\n`

  // Year breakdown — critical for "how many in March 2026?" type questions
  if (year_breakdown && Object.keys(year_breakdown).length > 0) {
    const parts = Object.entries(year_breakdown)
      .map(([yr, cnt]) => `${yr}: ${cnt}`)
      .join(', ')
    summary += `COUNT BY YEAR: ${parts}\n`
  }

  summary += truncated
    ? `SHOWING: first ${MAX_ROWS_FOR_LLM} of ${filtered_count} matched rows below\n`
    : `SHOWING: all ${filtered_count} matched rows below\n`

  const skipCols = TAB_SKIP_COLUMNS[tab] ?? new Set()
  const displayColumns = columns.filter(col => !skipCols.has(col))

  const lines = displayRows.map(r =>
    displayColumns
      .filter(col => r[col] !== undefined && r[col] !== '')
      .map(col => `${col}: ${r[col]}`)
      .join(' | ')
  )

  return summary + '\n' + lines.join('\n')
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const sheetQueryTool = {
  id: 'sheet_query',

  description:
    'Queries the WEH Ventures deal-tracking Google Sheet. ' +
    'You MUST always specify the "tab" parameter. ' +
    'For cross-tab questions (e.g. "compare inbound vs outbound"), call this tool multiple times.\n\n' +
    'Tab schemas (exact column names):\n\n' +
    '(1) tab="Sheet1" — INBOUND contacts log.\n' +
    '    Columns: Timestamp (date), Name, Industry, Description, Logged By, Team Meeting, Notes.\n' +
    '    Use for: inbound leads, who logged what, lead descriptions and notes.\n\n' +
    '(2) tab="Outbound Contacts" — Outbound outreach log.\n' +
    '    Columns: Date, Name, Company Name, Industry, Description, Logged By, Reverted?, Email, Remarks, Team Meeting.\n' +
    '    Use for: outbound contacts, outreach activity, who we reached out to.\n\n' +
    '(3) tab="Referrals" — Referral tracking.\n' +
    '    Columns: Date, Name, Company Name, Industry, Description, Direction (Inbound/Outbound), Logged By, Reverted?, Email, Remarks, Priority, Team Meeting.\n' +
    '    Use for: referrals, direction of referrals, priority contacts.\n\n' +
    '(4) tab="Team meetings" — Deal pipeline evaluations.\n' +
    '    Columns: Company, Date, POC, Sector, Status (Pass/IC/Track/Founder watch), "Why is this exciting?", Risks, "Conviction Score (on 10)", "Reasons for Pass", "Reasons to watch", "Action required".\n' +
    '    Use for: conviction scores, deal pipeline status, pass/watch reasons, IC decisions, sector analysis.\n\n' +
    'Filters: use filterMonth (e.g. "March"), filterYear (e.g. "2025"), filterKeyword (company name or text) to narrow results.',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "The user's question"
      },
      tab: {
        type: 'string',
        description: 'REQUIRED. One of: "Sheet1", "Outbound Contacts", "Referrals", "Team meetings"'
      },
      filterMonth: {
        type: 'string',
        description: 'Optional. Month name to filter by, e.g. "March", "January"'
      },
      filterYear: {
        type: 'string',
        description: 'Optional. 4-digit year to filter by, e.g. "2025"'
      },
      filterKeyword: {
        type: 'string',
        description: 'Optional. Company name or keyword to filter across all columns'
      },
    },
    required: ['query', 'tab']
  },

  async execute({ input }) {
    const { tab, filterMonth, filterYear, filterKeyword } = input ?? {}

    if (!tab) {
      return {
        sheetContext:
          'Error: "tab" parameter is required. ' +
          'Must be one of: "Sheet1", "Outbound Contacts", "Referrals", "Team meetings"'
      }
    }

    console.log(
      `[sheetQueryTool] tab="${tab}"` +
      (filterMonth   ? ` month="${filterMonth}"`   : '') +
      (filterYear    ? ` year="${filterYear}"`    : '') +
      (filterKeyword ? ` keyword="${filterKeyword}"` : '')
    )

    try {
      const result = await runPythonQuery({ tab, filterMonth, filterYear, filterKeyword })

      if (result.error) {
        console.error('[sheetQueryTool] Python returned error:', result.error)
        return { sheetContext: `Sheet query error: ${result.error}` }
      }

      const formatted = formatRowsForLLM(result)
      return { sheetContext: formatted }

    } catch (err) {
      console.error('[sheetQueryTool] Execution error:', err.message)
      return { sheetContext: `Failed to query sheet: ${err.message}` }
    }
  }
}
