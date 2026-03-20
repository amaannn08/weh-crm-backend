import 'dotenv/config'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { initSchema, sql } from '../db/neon.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = __filename.substring(0, __filename.lastIndexOf('/'))

function parseCsvLine(line) {
  const result = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      const next = line[i + 1]
      if (next === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

function parseMeetingDate(raw) {
  const value = (raw || '').trim()
  if (!value) return null

  // Strip ordinal suffixes like "20th", "6th", etc.
  const cleaned = value.replace(/(\d+)(st|nd|rd|th)/gi, '$1').replace(/\./g, '')
  const parts = cleaned.split(/\s+/)
  if (parts.length < 2) return null

  const day = Number(parts[0])
  if (!day || Number.isNaN(day)) return null

  const monthToken = parts[1].toLowerCase()
  const months = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12
  }
  const month = months[monthToken]
  if (!month) return null

  const year = new Date().getFullYear()
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return iso
}

async function main() {
  await initSchema()

  const csvPath = join(
    __dirname,
    '..',
    'WEH Outreach & Inbound - Team meetings.csv'
  )
  const raw = await readFile(csvPath, 'utf8')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length <= 1) {
    console.log('No data rows found in meetings CSV')
    return
  }

  const header = parseCsvLine(lines[0])
  const colIndex = (name) => header.indexOf(name)

  const companyIdx = colIndex('Company')
  const dateIdx = colIndex('Date')
  const pocIdx = colIndex('POC')
  const sectorIdx = colIndex('Sector')
  const statusIdx = colIndex('Status')
  const excitingIdx = colIndex('Why is this exciting?')
  const risksIdx = colIndex('Risks')
  const convictionIdx = colIndex('Conviction Score (on 10)')
  const passIdx = colIndex('Reasons for Pass')
  const watchIdx = colIndex('Reasons to watch')
  const actionIdx = colIndex('Action required')

  const missing = [
    ['Company', companyIdx],
    ['Date', dateIdx],
    ['POC', pocIdx],
    ['Sector', sectorIdx],
    ['Status', statusIdx],
    ['Why is this exciting?', excitingIdx],
    ['Risks', risksIdx],
    ['Conviction Score (on 10)', convictionIdx],
    ['Reasons for Pass', passIdx],
    ['Reasons to watch', watchIdx],
    ['Action required', actionIdx]
  ].filter(([, idx]) => idx === -1)

  if (missing.length) {
    throw new Error(
      `Missing expected columns in meetings CSV: ${missing
        .map(([name]) => name)
        .join(', ')}`
    )
  }

  const notMatched = []
  let inserted = 0
  let skippedExisting = 0

  // Skip header
  // eslint-disable-next-line no-plusplus
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const companyRaw = cols[companyIdx] ?? ''
    const company = companyRaw.trim()
    if (!company) continue

    const dateRaw = cols[dateIdx] ?? ''
    const poc = (cols[pocIdx] ?? '').trim() || null
    const sector = (cols[sectorIdx] ?? '').trim() || null
    const status = (cols[statusIdx] ?? '').trim() || null
    const exciting_reason = (cols[excitingIdx] ?? '').trim() || null
    const risks = (cols[risksIdx] ?? '').trim() || null
    const convictionRaw = (cols[convictionIdx] ?? '').trim()
    const conviction_score = convictionRaw ? Number(convictionRaw) : null
    const pass_reasons = (cols[passIdx] ?? '').trim() || null
    const watch_reasons = (cols[watchIdx] ?? '').trim() || null
    const action_required = (cols[actionIdx] ?? '').trim() || null

    const meetingDate = parseMeetingDate(dateRaw)

    let dealRows = await sql`
      SELECT id, company
      FROM deals
      WHERE LOWER(TRIM(company)) = LOWER(TRIM(${company}))
      LIMIT 1
    `
    let deal = dealRows[0]
    if (!deal) {
      // Create a minimal deal when it does not already exist
      dealRows = await sql`
        INSERT INTO deals (
          company,
          date,
          poc,
          sector,
          status,
          exciting_reason,
          risks,
          conviction_score,
          pass_reasons,
          watch_reasons,
          action_required
        )
        VALUES (
          ${company},
          ${meetingDate},
          ${poc},
          ${sector},
          ${status},
          ${exciting_reason},
          ${risks},
          ${conviction_score},
          ${pass_reasons},
          ${watch_reasons},
          ${action_required}
        )
        RETURNING id, company
      `
      // eslint-disable-next-line prefer-destructuring
      deal = dealRows[0]
      notMatched.push({ company, row: i + 1, createdDeal: true })
    }

    const existingRows = await sql`
      SELECT id
      FROM deal_meetings
      WHERE deal_id = ${deal.id}
      LIMIT 1
    `
    if (existingRows[0]) {
      skippedExisting += 1
      // eslint-disable-next-line no-continue
      continue
    }

    await sql`
      INSERT INTO deal_meetings (
        deal_id,
        company,
        meeting_date,
        poc,
        sector,
        status,
        exciting_reason,
        risks,
        conviction_score,
        pass_reasons,
        watch_reasons,
        action_required
      )
      VALUES (
        ${deal.id},
        ${deal.company},
        ${meetingDate},
        ${poc},
        ${sector},
        ${status},
        ${exciting_reason},
        ${risks},
        ${conviction_score},
        ${pass_reasons},
        ${watch_reasons},
        ${action_required}
      )
    `
    inserted += 1
  }

  console.log(
    JSON.stringify(
      {
        inserted,
        skippedExisting,
        notMatched
      },
      null,
      2
    )
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

