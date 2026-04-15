import 'dotenv/config'
import { google } from 'googleapis'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { sql, formatVector, initSchema } from '../db/neon.js'
import { embed } from '../services/embeddings.js'
import { extractDealFromTranscript } from '../services/dealExtraction.js'
import { scoreAndSaveFounder, mergeScoresForCompanyIdentity } from '../services/founderScoring.js'
import {
  isCompanyNameMissing,
  normalizeCompanyName,
  pickBestNonWehDomainFromTranscript,
  resolveCompanyNameFallback
} from '../services/companyIdentity.js'
import {
  evaluateDealIdentity,
  createDealIdentityAmbiguity
} from '../services/dealIdentityResolution.js'

const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document'

// ─────────────────────────────────────────────────────────────────────────────
// Auth — prefers OAuth2 token file; falls back to service account
// ─────────────────────────────────────────────────────────────────────────────

function getDriveClient() {
  const tokenPath = join(process.cwd(), process.env.GOOGLE_TOKEN_PATH || 'google-token.json')
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  // OAuth2 path (CLIENT_ID + CLIENT_SECRET + saved token)
  if (existsSync(tokenPath)) {
    const CLIENT_ID = process.env.CLIENT_ID
    const CLIENT_SECRET = process.env.CLIENT_SECRET
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('CLIENT_ID and CLIENT_SECRET must be set in .env to use OAuth2 token')
    }
    const tokens = JSON.parse(readFileSync(tokenPath, 'utf8'))
    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    )
    oauth2Client.setCredentials(tokens)

    // Auto-persist refreshed tokens so they don't expire
    oauth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens }
      writeFileSync(tokenPath, JSON.stringify(merged, null, 2))
      console.log('[driveIngest] OAuth2 tokens refreshed and saved')
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
      fields: 'nextPageToken, files(id, name, mimeType)',
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

async function getFileText(drive, fileId, mimeType) {
  if (mimeType === GOOGLE_DOCS_MIME) {
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'stream' }
    )
    return (await streamToBuffer(res.data)).toString('utf8')
  }
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  )
  return (await streamToBuffer(res.data)).toString('utf8')
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
  `
}

async function getTrackingStatus(driveFileId) {
  const rows = await sql`
    SELECT status
    FROM drive_transcript_ingestion_status
    WHERE drive_file_id = ${driveFileId}
    LIMIT 1
  `
  return rows[0]?.status || 'pending'
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

// ─────────────────────────────────────────────────────────────────────────────
// Full per-file ingest: meeting → deal → founder scores
// ─────────────────────────────────────────────────────────────────────────────

async function ingestFile(drive, file) {
  const label = `[driveIngest] ${file.name} (${file.id})`

  let text
  try {
    text = await getFileText(drive, file.id, file.mimeType || '')
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
  const companyMissing = isCompanyNameMissing(extractedCompany)
  const resolvedCompanyName = await resolveCompanyNameFallback({
    company: extraction.company,
    founderName: extraction.founder_name
  })
  const companyDomain = pickBestNonWehDomainFromTranscript(transcript)
  const meetingDate = extraction.meeting_date || null

  // 1. Store meeting with embedding
  const embedding = await embed(transcript)
  const vectorStr = formatVector(embedding)
  const companyForMeeting = companyMissing ? null : (extraction.company || null)

  const meetingRows = await sql`
    INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding, company)
    VALUES (${file.id}, ${file.name ?? null}, ${transcript}, ${vectorStr}::vector, ${companyForMeeting})
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
      extractedCompany,
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
        extractedCompany: extraction.company || null,
        normalizedCompany: normalizeCompanyName(extraction.company),
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
    await mergeScoresForCompanyIdentity({
      dealId,
      companyName: companyMissing ? null : extractedCompany,
      companyDomain
    })
  }

  console.log(`${label}: fully ingested → deal ${dealId}`)
  return {
    status: 'processed',
    companyName: companyMissing ? null : (extractedCompany || null)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runDriveIngest() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID
  if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required')

  await initSchema()

  const drive = getDriveClient()
  const files = await listFilesInFolder(drive, folderId)

  let processed = 0
  let skipped = 0
  let errors = 0

  for (const file of files) {
    await upsertDiscoveredFile(file)

    const trackingStatus = await getTrackingStatus(file.id)
    const shouldProcess = trackingStatus === 'pending' || trackingStatus === 'failed'
    if (!shouldProcess) {
      skipped++
      continue
    }

    try {
      await markProcessing(file)
      const result = await ingestFile(drive, file)
      if (result.status === 'processed') {
        await markSuccess(file, result.companyName)
        processed++
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

  const summary = { processed, skipped, errors, total: files.length }
  console.log('[driveIngest] Done:', summary)
  return summary
}
