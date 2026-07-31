/**
 * reingestFailed.js
 *
 * Resets all 'failed' rows in drive_transcript_ingestion_status back to
 * 'pending', then triggers a full runDriveIngest() pass to process them
 * along with any newly discovered (untracked) files.
 *
 * Usage:
 *   node scripts/reingestFailed.js
 */
import 'dotenv/config'
import { sql } from '../db/neon.js'
import { runDriveIngest } from '../pipelines/driveIngestion.js'

// 1. Show current status before reset
const before = await sql`
  SELECT status, COUNT(*) as count
  FROM drive_transcript_ingestion_status
  GROUP BY status
  ORDER BY count DESC
`
console.log('--- Status before reset ---')
console.table(before)

// 2. Reset all failed rows to pending so they get retried
const reset = await sql`
  UPDATE drive_transcript_ingestion_status
  SET
    status = 'pending',
    last_error = NULL,
    last_attempt_at = NULL
  WHERE status = 'failed'
  RETURNING drive_file_id, source_file_name
`
console.log(`\nReset ${reset.length} failed file(s) to pending:`)
reset.forEach(r => console.log(' -', r.source_file_name ?? r.drive_file_id))

// 3. Run ingestion — picks up all pending + newly discovered files
console.log('\nStarting drive ingestion...')
const result = await runDriveIngest()
console.log('\n--- Ingestion result ---')
console.log(result)

// 4. Show final status
const after = await sql`
  SELECT status, COUNT(*) as count
  FROM drive_transcript_ingestion_status
  GROUP BY status
  ORDER BY count DESC
`
console.log('\n--- Status after ingestion ---')
console.table(after)

process.exit(0)
