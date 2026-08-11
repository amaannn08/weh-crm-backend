/**
 * addMeetingDateColumn.js
 *
 * Step 1: ALTER TABLE to add meeting_date column.
 * Step 2: Backfill existing rows using:
 *   Priority 1 — deals.meeting_date (AI-extracted, most accurate)
 *   Priority 2 — parse date from source_file_name filename
 *   Priority 3 — leave NULL
 */
import 'dotenv/config'
import { query, poolRef } from '../db/neon.js'

/**
 * Parse a date from Drive transcript filenames like:
 *   "Turom x WEH Ventures - 2026/07/08 11:00 IST - Notes by Gemini"
 *   "Tarun Agrawal and Ritik Rustagi - 2026_07_13 16_30 IST - Notes by Gemini"
 *   "WEH Ventures Call (Tez. Health) - 2026/05/19 14:53 IST Notes by Gemini"
 */
function parseDateFromFilename(filename) {
  if (!filename) return null

  // Match YYYY/MM/DD or YYYY_MM_DD or YYYY-MM-DD
  const match = filename.match(/(\d{4})[\/\-_](\d{2})[\/\-_](\d{2})/)
  if (!match) return null

  const [, year, month, day] = match
  const y = parseInt(year, 10)
  const m = parseInt(month, 10)
  const d = parseInt(day, 10)

  // Sanity checks
  if (y < 2020 || y > 2030) return null
  if (m < 1 || m > 12) return null
  if (d < 1 || d > 31) return null

  return `${year}-${month}-${day}`
}

async function run() {
  // ── Step 1: Add the column ──────────────────────────────────────────────────
  console.log('Step 1: Adding meeting_date column to meetings table...')
  await query(`
    ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS meeting_date DATE
  `)
  console.log('✅ Column added (or already existed)\n')

  // ── Step 2: Backfill from deals.meeting_date ────────────────────────────────
  console.log('Step 2a: Backfilling from deals.meeting_date...')
  const fromDeals = await query(`
    UPDATE meetings m
    SET meeting_date = d.meeting_date
    FROM deals d
    WHERE (
      m.source_file_name = d.source_file_name
      OR m.drive_file_id  = d.source_file_name
    )
    AND d.meeting_date IS NOT NULL
    AND m.meeting_date IS NULL
    RETURNING m.id
  `)
  console.log(`✅ Updated ${fromDeals.rows.length} meetings from deals.meeting_date\n`)

  // ── Step 3: Backfill remaining rows from filename ───────────────────────────
  console.log('Step 2b: Backfilling remaining rows from filename...')
  const nullRows = await query(`
    SELECT id, source_file_name
    FROM meetings
    WHERE meeting_date IS NULL
      AND source_file_name IS NOT NULL
  `)
  console.log(`   Found ${nullRows.rows.length} rows still without a date. Parsing filenames...`)

  let filenameUpdates = 0
  let unparseable = 0

  for (const row of nullRows.rows) {
    const parsed = parseDateFromFilename(row.source_file_name)
    if (parsed) {
      await query(
        `UPDATE meetings SET meeting_date = $1 WHERE id = $2`,
        [parsed, row.id]
      )
      filenameUpdates++
    } else {
      unparseable++
    }
  }

  console.log(`✅ Updated ${filenameUpdates} meetings from filename parsing`)
  console.log(`⚠️  ${unparseable} rows left NULL (filename had no parseable date)\n`)

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = await query(`SELECT count(*) FROM meetings`)
  const withDate = await query(`SELECT count(*) FROM meetings WHERE meeting_date IS NOT NULL`)
  const sample = await query(`
    SELECT source_file_name, meeting_date
    FROM meetings
    WHERE meeting_date IS NOT NULL
    ORDER BY meeting_date DESC
    LIMIT 10
  `)

  console.log(`=== Backfill Summary ===`)
  console.log(`Total meetings:     ${total.rows[0].count}`)
  console.log(`With meeting_date:  ${withDate.rows[0].count}`)
  console.log(`\nSample (most recent):`)
  sample.rows.forEach(r => console.log(`  ${r.meeting_date}  ${r.source_file_name?.slice(0, 60)}`))

  await poolRef.end()
  process.exit(0)
}

run().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
