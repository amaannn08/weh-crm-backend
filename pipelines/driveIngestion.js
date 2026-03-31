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
  pickBestNonWehDomainFromTranscript
} from '../services/companyIdentity.js'

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
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 200
  })
  return data.files || []
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

async function isAlreadyIngested(driveFileId) {
  const rows = await sql`SELECT 1 FROM meetings WHERE drive_file_id = ${driveFileId} LIMIT 1`
  return rows.length > 0
}

async function findDealBySourceFile(fileName) {
  const rows = await sql`SELECT id FROM deals WHERE source_file_name = ${fileName} LIMIT 1`
  return rows[0] ?? null
}

async function findDealByCompanyName(companyName) {
  const normalized = normalizeCompanyName(companyName)
  if (!normalized) return null
  const rows = await sql`SELECT id FROM deals WHERE LOWER(TRIM(company)) = ${normalized} LIMIT 1`
  return rows[0] ?? null
}

async function findDealByCompanyDomain(companyDomain) {
  if (!companyDomain) return null
  const rows = await sql`SELECT id FROM deals WHERE company_domain = ${companyDomain} LIMIT 1`
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
    console.warn(`${label}: could not fetch text — ${e.message}`)
    return 'error'
  }

  const transcript = text?.trim()
  if (!transcript) {
    console.warn(`${label}: empty content, skipping`)
    return 'error'
  }

  let extraction
  try {
    extraction = await extractDealFromTranscript({ transcript })
  } catch (e) {
    console.warn(`${label}: deal extraction failed — ${e.message}`)
    return 'error'
  }

  const extractedCompany = extraction.company || ''
  const companyMissing = isCompanyNameMissing(extractedCompany)
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

  const byFile = await findDealBySourceFile(file.name)
  if (byFile) {
    dealId = byFile.id
  } else {
    const byName = !companyMissing ? await findDealByCompanyName(extractedCompany) : null
    const byDomain = !byName && companyDomain ? await findDealByCompanyDomain(companyDomain) : null
    const identityMatch = byName || byDomain
    if (identityMatch?.id) {
      dealId = identityMatch.id
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
        ${extraction.company || 'Unknown company'},
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
  return 'processed'
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
    if (await isAlreadyIngested(file.id)) {
      skipped++
      continue
    }
    try {
      const result = await ingestFile(drive, file)
      if (result === 'processed') processed++
      else errors++
    } catch (e) {
      console.error(`[driveIngest] Unexpected error for ${file.name}:`, e)
      errors++
    }
  }

  const summary = { processed, skipped, errors, total: files.length }
  console.log('[driveIngest] Done:', summary)
  return summary
}
