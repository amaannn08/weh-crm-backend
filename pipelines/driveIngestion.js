import 'dotenv/config'
import { google } from 'googleapis'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import mammoth from 'mammoth'
import { sql, formatVector, initSchema, acquireLock, releaseLock } from '../db/neon.js'
import { embed } from '../services/embeddings.js'
import { cleanOrphanedTranscripts } from '../services/cleanup.js'
import { extractDealFromTranscript } from '../services/dealExtraction.js'
import { scoreAndSaveFounder, mergeScoresForCompanyIdentity } from '../services/founderScoring.js'
import {
  deriveCompanyNameFromDomain,
  isCompanyNameMissing,
  isPlainGmailDomain,
  normalizeCompanyName,
  pickBestNonWehDomainFromTranscript,
  resolveCompanyNameFallback
} from '../services/companyIdentity.js'
import {
  evaluateDealIdentity,
  createDealIdentityAmbiguity
} from '../services/dealIdentityResolution.js'

const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

let isIngestRunning = false

// ─────────────────────────────────────────────────────────────────────────────
// Auth — prefers OAuth2 token file; falls back to service account
// ─────────────────────────────────────────────────────────────────────────────

function getDriveClient() {
  const tokenEnv = process.env.GOOGLE_TOKEN_JSON
  const tokenPath = join(process.cwd(), process.env.GOOGLE_TOKEN_PATH || 'google-token.json')
  const secretPath = '/etc/secrets/google-token.json'
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  let tokens = null
  let activeTokenPath = null

  if (tokenEnv) {
    try {
      tokens = typeof tokenEnv === 'string' ? JSON.parse(tokenEnv) : tokenEnv
    } catch (e) {
      console.error('[driveIngest] Failed to parse GOOGLE_TOKEN_JSON env var:', e.message)
    }
  } else if (existsSync(tokenPath)) {
    tokens = JSON.parse(readFileSync(tokenPath, 'utf8'))
    activeTokenPath = tokenPath
  } else if (existsSync(secretPath)) {
    tokens = JSON.parse(readFileSync(secretPath, 'utf8'))
    activeTokenPath = secretPath
  }

  // OAuth2 path (CLIENT_ID + CLIENT_SECRET + saved token)
  if (tokens) {
    const CLIENT_ID = process.env.CLIENT_ID
    const CLIENT_SECRET = process.env.CLIENT_SECRET
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('CLIENT_ID and CLIENT_SECRET must be set in .env to use OAuth2 token')
    }
    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    )
    oauth2Client.setCredentials(tokens)

    // Auto-persist refreshed tokens if a file path exists
    oauth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens }
      if (activeTokenPath) {
        try {
          writeFileSync(activeTokenPath, JSON.stringify(merged, null, 2))
          console.log('[driveIngest] OAuth2 tokens refreshed and saved')
        } catch {
          // ignore write errors on read-only secret mounts
        }
      }
    })

    return google.drive({ version: 'v3', auth: oauth2Client })
  }

  // Service account path
  if (credPath) {
    const keyPath = join(process.cwd(), credPath)
    const key = JSON.parse(readFileSync(keyPath, 'utf8'))
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    })
    return google.drive({ version: 'v3', auth })
  }

  throw new Error(
    'No Drive credentials found. Run: node scripts/authorizeGoogleDrive.js'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive helpers
// ─────────────────────────────────────────────────────────────────────────────

async function listFilesInFolder(drive, folderId) {
  const allFiles = []
  let nextPageToken = null
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails)',
      pageSize: 200,
      pageToken: nextPageToken || undefined
    })
    allFiles.push(...(data.files || []))
    nextPageToken = data.nextPageToken || null
  } while (nextPageToken)
  return allFiles
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function stripNullBytes(str) {
  return str.replace(/\0/g, '')
}

async function getFileText(drive, fileId, mimeType, shortcutDetails = null) {
  let targetId = fileId
  let targetMimeType = mimeType

  if (mimeType === SHORTCUT_MIME && shortcutDetails?.targetId) {
    targetId = shortcutDetails.targetId
    targetMimeType = shortcutDetails.targetMimeType || GOOGLE_DOCS_MIME
  }

  // Google Docs — export as plain text
  if (targetMimeType === GOOGLE_DOCS_MIME) {
    const res = await drive.files.export(
      { fileId: targetId, mimeType: 'text/plain' },
      { responseType: 'stream' }
    )
    return stripNullBytes((await streamToBuffer(res.data)).toString('utf8'))
  }
  // Binary .docx — use mammoth to extract readable text, avoids null-byte UTF-8 errors
  if (targetMimeType === DOCX_MIME) {
    const res = await drive.files.get(
      { fileId: targetId, alt: 'media' },
      { responseType: 'arraybuffer' }
    )
    const buffer = Buffer.from(res.data)
    const { value: text } = await mammoth.extractRawText({ buffer })
    return stripNullBytes(text)
  }
  // Fallback for other file types
  const res = await drive.files.get(
    { fileId: targetId, alt: 'media' },
    { responseType: 'stream' }
  )
  return stripNullBytes((await streamToBuffer(res.data)).toString('utf8'))
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

function toErrorMessage(error) {
  if (!error) return 'Unknown ingestion error'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

async function upsertDiscoveredFile(file) {
  const existingTrackingRows = await sql`
    SELECT status
    FROM drive_transcript_ingestion_status
    WHERE drive_file_id = ${file.id}
    LIMIT 1
  `

  if (existingTrackingRows.length > 0) {
    await sql`
      UPDATE drive_transcript_ingestion_status
      SET source_file_name = ${file.name ?? null}
      WHERE drive_file_id = ${file.id}
    `
    return
  }

  const existingMeetingRows = await sql`
    SELECT ingested_at
    FROM meetings
    WHERE drive_file_id = ${file.id}
    LIMIT 1
  `
  const existingMeeting = existingMeetingRows[0] ?? null
  const bootstrapStatus = existingMeeting ? 'success' : 'pending'

  await sql`
    INSERT INTO drive_transcript_ingestion_status (
      drive_file_id,
      source_file_name,
      status,
      ingested_at
    )
    VALUES (
      ${file.id},
      ${file.name ?? null},
      ${bootstrapStatus},
      ${existingMeeting?.ingested_at ?? null}
    )
    ON CONFLICT (drive_file_id) DO UPDATE
    SET source_file_name = EXCLUDED.source_file_name
  `
}

async function getTrackingStatus(driveFileId) {
  const rows = await sql`
    SELECT status, last_attempt_at
    FROM drive_transcript_ingestion_status
    WHERE drive_file_id = ${driveFileId}
    LIMIT 1
  `
  return rows[0] || { status: 'pending', last_attempt_at: null }
}

function isStaleProcessing(lastAttemptAt) {
  if (!lastAttemptAt) return false
  const timeoutMinutesRaw = Number(process.env.DRIVE_INGEST_STALE_PROCESSING_MINUTES || '180')
  const timeoutMinutes = Number.isFinite(timeoutMinutesRaw) && timeoutMinutesRaw > 0
    ? timeoutMinutesRaw
    : 180
  const lastAttemptMs = new Date(lastAttemptAt).getTime()
  if (!Number.isFinite(lastAttemptMs)) return false
  const ageMs = Date.now() - lastAttemptMs
  return ageMs > timeoutMinutes * 60 * 1000
}

async function markProcessing(file) {
  await sql`
    UPDATE drive_transcript_ingestion_status
    SET
      status = ${'processing'},
      source_file_name = ${file.name ?? null},
      attempt_count = attempt_count + 1,
      last_attempt_at = NOW(),
      last_error = NULL
    WHERE drive_file_id = ${file.id}
  `
}

async function markFailed(file, errorMessage) {
  await sql`
    UPDATE drive_transcript_ingestion_status
    SET
      status = ${'failed'},
      source_file_name = ${file.name ?? null},
      last_error = ${errorMessage}
    WHERE drive_file_id = ${file.id}
  `
}

async function markSuccess(file, companyName) {
  await sql`
    UPDATE drive_transcript_ingestion_status
    SET
      status = ${'success'},
      source_file_name = ${file.name ?? null},
      company_name = ${companyName || null},
      ingested_at = NOW(),
      last_error = NULL
    WHERE drive_file_id = ${file.id}
  `
}

async function findDealBySourceFile(fileName) {
  const rows = await sql`SELECT id FROM deals WHERE source_file_name = ${fileName} LIMIT 1`
  return rows[0] ?? null
}

function deriveRiskLevel(investorReaction) {
  const level = (investorReaction?.investor_interest_level || '').toLowerCase()
  if (!level) return null
  if (level.includes('high')) return 'Low'
  if (level.includes('medium')) return 'Medium'
  if (level.includes('low')) return 'High'
  return null
}

async function refreshDealMeetingDate(dealId, meetingDate) {
  if (!dealId || !meetingDate) return
  await sql`
    UPDATE deals
    SET
      meeting_date = CASE
        WHEN meeting_date IS NULL THEN ${meetingDate}::date
        ELSE GREATEST(meeting_date, ${meetingDate}::date)
      END,
      date = CASE
        WHEN date IS NULL THEN ${meetingDate}::date
        ELSE GREATEST(date, ${meetingDate}::date)
      END
    WHERE id = ${dealId}
  `
}

// ─────────────────────────────────────────────────────────────────────────────
// Full per-file ingest: meeting → deal → founder scores
// ─────────────────────────────────────────────────────────────────────────────

async function ingestFile(drive, file) {
  const label = `[driveIngest] ${file.name} (${file.id})`

  let text
  try {
    text = await getFileText(drive, file.id, file.mimeType || '', file.shortcutDetails || null)
  } catch (e) {
    const errorMessage = `could not fetch text — ${toErrorMessage(e)}`
    console.warn(`${label}: ${errorMessage}`)
    return { status: 'error', error: errorMessage }
  }

  const transcript = text?.trim()
  if (!transcript) {
    const errorMessage = 'empty content, skipping'
    console.warn(`${label}: ${errorMessage}`)
    return { status: 'error', error: errorMessage }
  }

  let extraction
  try {
    extraction = await extractDealFromTranscript({ transcript })
  } catch (e) {
    const errorMessage = `deal extraction failed — ${toErrorMessage(e)}`
    console.warn(`${label}: ${errorMessage}`)
    return { status: 'error', error: errorMessage }
  }

  const extractedCompany = extraction.company || ''
  const companyDomain = pickBestNonWehDomainFromTranscript(transcript)
  const domainDerivedCompany = deriveCompanyNameFromDomain(companyDomain)
  const shouldUseTranscriptFallback = !companyDomain || isPlainGmailDomain(companyDomain)
  const prioritizedCompany = domainDerivedCompany || extraction.company
  const companyMissing = isCompanyNameMissing(prioritizedCompany)
  const resolvedCompanyName = shouldUseTranscriptFallback
    ? await resolveCompanyNameFallback({
      company: extraction.company,
      founderName: extraction.founder_name
    })
    : (domainDerivedCompany || extraction.company || null)
  const meetingDate = extraction.meeting_date || null

  // 1. Store meeting with embedding
  const embedding = await embed(transcript)
  const vectorStr = formatVector(embedding)
  const companyForMeeting = companyMissing ? null : (prioritizedCompany || null)

  const meetingRows = await sql`
    INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding, company, meeting_date)
    VALUES (${file.id}, ${file.name ?? null}, ${transcript}, ${vectorStr}::vector, ${companyForMeeting}, ${meetingDate}::date)
    RETURNING id
  `
  const meetingId = meetingRows[0].id
  console.log(`${label}: meeting ${meetingId} stored`)

  // 2. Deduplicate and upsert deal
  let dealId = null
  let matchedExistingIdentity = false
  let identityDecision = null

  const byFile = await findDealBySourceFile(file.name)
  if (byFile) {
    dealId = byFile.id
  } else {
    identityDecision = await evaluateDealIdentity({
      extractedCompany: prioritizedCompany,
      companyDomain,
      companyMissing
    })
    if (identityDecision.decision === 'resolved' && identityDecision.resolvedDealId) {
      dealId = identityDecision.resolvedDealId
      matchedExistingIdentity = true
    }
  }

  if (!dealId) {
    const dealRows = await sql`
      INSERT INTO deals (
        company, company_domain, date, poc, sector, founder_name,
        meeting_date, business_model, status, stage, risk_level,
        exciting_reason, risks, conviction_score, pass_reasons,
        watch_reasons, action_required, source_file_name
      )
      VALUES (
        ${resolvedCompanyName},
        ${companyDomain},
        ${meetingDate},
        ${extraction.poc || null},
        ${extraction.sector || null},
        ${extraction.founder_name || null},
        ${meetingDate},
        ${extraction.business_model || null},
        ${'New'},
        ${extraction.stage || null},
        ${deriveRiskLevel(extraction.investor_reaction)},
        ${extraction.deal_decision?.why_exciting || null},
        ${extraction.deal_decision?.risks || null},
        ${extraction.deal_decision?.conviction_score ?? null},
        ${extraction.deal_decision?.reasons_pass || null},
        ${extraction.deal_decision?.reasons_watch || null},
        ${extraction.deal_decision?.action_required || null},
        ${file.name}
      )
      RETURNING id
    `
    dealId = dealRows[0].id

    if (identityDecision?.decision === 'ambiguous') {
      await createDealIdentityAmbiguity({
        sourceType: 'drive',
        sourceFileId: file.id,
        sourceFileName: file.name ?? null,
        extractedCompany: prioritizedCompany || null,
        normalizedCompany: normalizeCompanyName(prioritizedCompany),
        extractedDomain: companyDomain,
        candidateDealIds: identityDecision.candidateDeals.map((deal) => deal.id),
        pendingDealId: dealId,
        payload: {
          reason: identityDecision.reason,
          founder_name: extraction.founder_name || null
        }
      })
    }
  }

  // 3. Deal insights
  await sql`
    INSERT INTO deal_insights (
      deal_id, meeting_outcome, founder_pitch, business_model_signals,
      market_signals, investor_reaction, supporting_quotes, raw_payload
    )
    VALUES (
      ${dealId},
      ${JSON.stringify(extraction.meeting_outcome ?? {})},
      ${JSON.stringify(extraction.founder_pitch ?? {})},
      ${JSON.stringify(extraction.business_model_signals ?? {})},
      ${JSON.stringify(extraction.market_signals ?? {})},
      ${JSON.stringify(extraction.investor_reaction ?? {})},
      ${JSON.stringify(extraction.supporting_quotes ?? {})},
      ${JSON.stringify(extraction)}
    )
  `

  // 4. Founder scoring
  await scoreAndSaveFounder({ dealId, transcript, extraction })

  if (matchedExistingIdentity) {
    await refreshDealMeetingDate(dealId, meetingDate)
    await mergeScoresForCompanyIdentity({
      dealId,
      companyName: companyMissing ? null : prioritizedCompany,
      companyDomain
    })
  }

  console.log(`${label}: fully ingested → deal ${dealId}`)
  return {
    status: 'processed',
    companyName: companyMissing ? null : (prioritizedCompany || null)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runDriveIngest() {
  if (isIngestRunning) {
    console.log('[driveIngest] Skipped: runDriveIngest is already executing in this process')
    return { status: 'skipped', reason: 'concurrent_in_process_run' }
  }
  isIngestRunning = true

  const workerId = process.env.RENDER_INSTANCE_ID || `worker-${process.pid}-${Date.now()}`
  let lockAcquired = false

  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID
    if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required')

    await initSchema()

    const lockRes = await acquireLock('drive_ingest', 30, workerId)
    if (!lockRes.acquired) {
      console.log(
        '[driveIngest] Skipped: another ingest run holds active DB lease',
        lockRes.currentLock
      )
      return {
        status: 'skipped',
        reason: 'concurrent_run_in_progress',
        currentLock: lockRes.currentLock
      }
    }
    lockAcquired = true

    const drive = getDriveClient()
    const files = await listFilesInFolder(drive, folderId)

    // Fetch all existing tracking rows in a single batch query for fast in-memory lookup
    const existingTrackingRows = await sql`
      SELECT drive_file_id, status, last_attempt_at, source_file_name
      FROM drive_transcript_ingestion_status
    `
    const trackingMap = new Map(existingTrackingRows.map((r) => [r.drive_file_id, r]))

    let processed = 0
    let skipped = 0
    let errors = 0
    const skipReasons = {
      success: 0,
      processing: 0,
      unsupported: 0
    }
    let staleRecovered = 0
    const shouldTrash = process.env.DRIVE_TRASH_PROCESSED_FILES === 'true'

    for (const file of files) {
      let tracking = trackingMap.get(file.id)

      if (!tracking) {
        await upsertDiscoveredFile(file)
        tracking = await getTrackingStatus(file.id)
        trackingMap.set(file.id, tracking)
      }

      const staleProcessing = tracking.status === 'processing' && isStaleProcessing(tracking.last_attempt_at)
      if (staleProcessing) {
        staleRecovered++
        await markFailed(file, 'stale processing status recovered for retry')
      }

      const effectiveStatus = staleProcessing ? 'failed' : tracking.status
      const shouldProcess = effectiveStatus === 'pending' || effectiveStatus === 'failed'
      if (!shouldProcess) {
        skipped++
        if (effectiveStatus === 'success') skipReasons.success++
        else if (effectiveStatus === 'processing') skipReasons.processing++
        else skipReasons.unsupported++
        continue
      }

      try {
        await markProcessing(file)
        const result = await ingestFile(drive, file)
        if (result.status === 'processed') {
          await markSuccess(file, result.companyName)
          processed++

          if (shouldTrash) {
            try {
              await drive.files.update({
                fileId: file.id,
                requestBody: { trashed: true }
              })
              console.log(`[driveIngest] Trashed processed Drive file: ${file.name} (${file.id})`)
            } catch (trashErr) {
              console.warn(
                `[driveIngest] Could not trash Drive file "${file.name}": ${trashErr.message}. ` +
                'Note: drive.readonly OAuth scope does not permit trashing.'
              )
            }
          }
        } else {
          await markFailed(file, result.error)
          errors++
        }
      } catch (e) {
        console.error(`[driveIngest] Unexpected error for ${file.name}:`, e)
        await markFailed(file, toErrorMessage(e))
        errors++
      }
    }

    // Sweep orphaned temp transcript doc files
    try {
      cleanOrphanedTranscripts()
    } catch (cleanErr) {
      console.warn('[driveIngest] Post-ingest cleanup sweep warning:', cleanErr.message)
    }

    const summary = {
      processed,
      skipped,
      errors,
      total: files.length,
      staleRecovered,
      skipReasons
    }
    console.log('[driveIngest] Done:', summary)
    return summary
  } finally {
    if (lockAcquired) {
      try {
        await releaseLock('drive_ingest', workerId)
      } catch (err) {
        console.warn('[driveIngest] Failed to release lock:', err.message)
      }
    }
    isIngestRunning = false
  }
}

const isDirectCli = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('driveIngestion.js')
)

if (isDirectCli) {
  runDriveIngest()
    .then((summary) => {
      console.log('[driveIngest] Finished successfully:', summary)
      process.exit(0)
    })
    .catch((err) => {
      console.error('[driveIngest] Fatal error:', err)
      process.exit(1)
    })
}
