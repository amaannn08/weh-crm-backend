/**
 * scripts/driveIngestStatus.js
 *
 * One-shot, read-only diagnostic and verification tool.
 * Queries Google Drive and Neon Postgres to inspect the live status of
 * Drive transcript ingestion without performing any mutations or ingestion.
 *
 * Usage:
 *   node scripts/driveIngestStatus.js
 */

import 'dotenv/config'
import { google } from 'googleapis'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { sql, getLockStatus } from '../db/neon.js'

function getDriveClient() {
  const tokenEnv = process.env.GOOGLE_TOKEN_JSON
  const tokenPath = join(process.cwd(), process.env.GOOGLE_TOKEN_PATH || 'google-token.json')
  const secretPath = '/etc/secrets/google-token.json'
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  let tokens = null
  if (tokenEnv) {
    try {
      tokens = typeof tokenEnv === 'string' ? JSON.parse(tokenEnv) : tokenEnv
    } catch (e) {
      console.error('[status] Failed to parse GOOGLE_TOKEN_JSON env var:', e.message)
    }
  } else if (existsSync(tokenPath)) {
    tokens = JSON.parse(readFileSync(tokenPath, 'utf8'))
  } else if (existsSync(secretPath)) {
    tokens = JSON.parse(readFileSync(secretPath, 'utf8'))
  }

  if (tokens) {
    const CLIENT_ID = process.env.CLIENT_ID
    const CLIENT_SECRET = process.env.CLIENT_SECRET
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('CLIENT_ID and CLIENT_SECRET must be set in .env')
    }
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET)
    oauth2Client.setCredentials(tokens)
    return google.drive({ version: 'v3', auth: oauth2Client })
  }

  if (credPath) {
    const keyPath = join(process.cwd(), credPath)
    const key = JSON.parse(readFileSync(keyPath, 'utf8'))
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    })
    return google.drive({ version: 'v3', auth })
  }

  throw new Error('No Google Drive credentials found in GOOGLE_TOKEN_JSON, google-token.json, or /etc/secrets/')
}

async function listAllDriveFiles(drive, folderId) {
  const files = []
  let pageToken = null
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails, createdTime, modifiedTime)',
      pageSize: 200,
      pageToken: pageToken || undefined
    })
    files.push(...(res.data.files || []))
    pageToken = res.data.nextPageToken || null
  } while (pageToken)
  return files
}

async function main() {
  console.log('================================================================')
  console.log('       WEH CRM — Google Drive Ingest Status (Read-Only)         ')
  console.log('================================================================')
  console.log('Timestamp:', new Date().toISOString())

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID
  if (!folderId) {
    console.error('❌ Error: GOOGLE_DRIVE_FOLDER_ID environment variable is missing.')
    process.exit(1)
  }
  console.log('Target Drive Folder ID:', folderId)

  // 1. Check Drive Folder
  let driveFiles = []
  try {
    const drive = getDriveClient()
    driveFiles = await listAllDriveFiles(drive, folderId)
    console.log(`\n📁 Total files in Google Drive folder: ${driveFiles.length}`)

    const mimeCounts = {}
    const shortcutTargetMimes = {}
    for (const f of driveFiles) {
      mimeCounts[f.mimeType] = (mimeCounts[f.mimeType] || 0) + 1
      if (f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails) {
        const targetType = f.shortcutDetails.targetMimeType || 'unknown'
        shortcutTargetMimes[targetType] = (shortcutTargetMimes[targetType] || 0) + 1
      }
    }

    console.log('\nBreakdown by MIME type:')
    for (const [mime, count] of Object.entries(mimeCounts)) {
      console.log(`  - ${mime}: ${count}`)
      if (mime === 'application/vnd.google-apps.shortcut') {
        for (const [tMime, tCount] of Object.entries(shortcutTargetMimes)) {
          console.log(`      ↳ targets ${tMime}: ${tCount}`)
        }
      }
    }
  } catch (err) {
    console.error('❌ Failed to fetch files from Google Drive:', err.message)
  }

  // 2. Query Neon Database Status
  try {
    const statusCounts = await sql`
      SELECT status, COUNT(*)::int AS count
      FROM drive_transcript_ingestion_status
      GROUP BY status
      ORDER BY count DESC
    `

    console.log('\n📊 Database Ingestion Status (drive_transcript_ingestion_status):')
    console.table(statusCounts)

    const newestSuccess = await sql`
      SELECT drive_file_id, source_file_name, company_name, ingested_at
      FROM drive_transcript_ingestion_status
      WHERE status = 'success'
      ORDER BY ingested_at DESC NULLS LAST
      LIMIT 1
    `

    if (newestSuccess.length > 0) {
      const latest = newestSuccess[0]
      console.log('\n🕒 Newest successful ingestion:')
      console.log(`   - File Name:    ${latest.source_file_name || latest.drive_file_id}`)
      console.log(`   - Company:      ${latest.company_name || 'N/A'}`)
      console.log(`   - Ingested At:  ${latest.ingested_at}`)
    } else {
      console.log('\n🕒 Newest successful ingestion: None recorded yet')
    }

    // Check failed items
    const failedRows = await sql`
      SELECT drive_file_id, source_file_name, attempt_count, last_attempt_at, last_error
      FROM drive_transcript_ingestion_status
      WHERE status = 'failed'
      ORDER BY last_attempt_at DESC NULLS LAST
    `

    if (failedRows.length > 0) {
      console.log(`\n⚠️  Currently failed files (${failedRows.length}):`)
      for (const row of failedRows) {
        const errorSummary = (row.last_error || 'No error recorded').split('\n')[0].slice(0, 100)
        console.log(`   - [${row.attempt_count} attempts] ${row.source_file_name || row.drive_file_id}`)
        console.log(`     Last Attempt: ${row.last_attempt_at}`)
        console.log(`     Error: ${errorSummary}`)
      }
    }

    // 3. Reconcile Drive Files vs Database Tracking
    if (driveFiles.length > 0) {
      const trackedRows = await sql`
        SELECT drive_file_id, status FROM drive_transcript_ingestion_status
      `
      const trackedMap = new Map(trackedRows.map((r) => [r.drive_file_id, r.status]))

      let driveSuccess = 0
      let driveFailed = 0
      let drivePending = 0
      let driveUntracked = 0

      for (const f of driveFiles) {
        const st = trackedMap.get(f.id)
        if (!st) driveUntracked++
        else if (st === 'success') driveSuccess++
        else if (st === 'failed') driveFailed++
        else if (st === 'pending') drivePending++
      }

      console.log('\n🔍 Drive vs Database Reconciliation:')
      console.log(`   - Tracked as Success in Drive: ${driveSuccess}`)
      console.log(`   - Tracked as Failed in Drive:  ${driveFailed}`)
      console.log(`   - Tracked as Pending in Drive: ${drivePending}`)
      console.log(`   - Untracked / New in Drive:    ${driveUntracked}`)
    }

    // 4. Lock / Lease Status
    const lock = await getLockStatus('drive_ingest')
    console.log('\n🔒 Overlap Lease Status (system_locks: "drive_ingest"):')
    if (lock && lock.is_active) {
      console.log(`   - State: ACTIVE LEASE (locked by: ${lock.locked_by})`)
      console.log(`   - Locked At:  ${lock.locked_at}`)
      console.log(`   - Expires At: ${lock.expires_at}`)
    } else {
      console.log('   - State: IDLE / AVAILABLE (no active ingestion lock)')
    }

    console.log('\n✅ Diagnosis complete. Exiting without side effects.\n')
    process.exit(0)
  } catch (dbErr) {
    console.error('❌ Failed to query Neon database:', dbErr)
    process.exit(1)
  }
}

main()
