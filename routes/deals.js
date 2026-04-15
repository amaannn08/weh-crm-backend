import express from 'express'
import multer from 'multer'
import { join, basename } from 'path'
import { mkdirSync, unlink, readFileSync } from 'fs'
import mammoth from 'mammoth'
import { sql, poolRef, formatVector } from '../db/neon.js'
import {
  clampScore,
  computeWeightedScore,
  computeFinalScore,
  scoreAndSaveFounder,
  getDDRecommendation,
  SOFT_WEIGHTS,
  HARD_WEIGHTS
} from '../services/founderScoring.js'
import { ingestDocs } from '../services/ingestDocs.js'
import { extractDealFromTranscript } from '../services/dealExtraction.js'
import { embed } from '../services/embeddings.js'
import {
  isCompanyNameMissing,
  normalizeCompanyName,
  pickBestNonWehDomainFromTranscript,
  resolveCompanyNameFallback
} from '../services/companyIdentity.js'
import { DealMergeError, mergeDealsTransactional } from '../services/dealMerge.js'
import {
  evaluateDealIdentity,
  createDealIdentityAmbiguity
} from '../services/dealIdentityResolution.js'

const DEAL_PATCH_FIELDS = [
  'company',
  'date',
  'poc',
  'sector',
  'status',
  'exciting_reason',
  'risks',
  'conviction_score',
  'pass_reasons',
  'watch_reasons',
  'action_required',
  'founder_soft_score',
  'founder_hard_score',
  'founder_final_score',
  'dd_recommendation'
]

const SOFT_PATCH_FIELDS = [
  'resilience',
  'ambition',
  'self_awareness',
  'domain_fit',
  'storytelling',
  'archetype'
]

const HARD_PATCH_FIELDS = [
  'education_tier',
  'domain_work_experience',
  'seniority_of_roles',
  'previous_startup_experience'
]

const router = express.Router()

const uploadDir = join(process.cwd(), 'uploads', 'deal-files')
mkdirSync(uploadDir, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const timestamp = Date.now()
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${timestamp}-${safeName}`)
    }
  })
})

// Separate multer instance for transcript uploads (temp dir, cleaned up after processing)
const transcriptUploadDir = join(process.cwd(), 'uploads', 'transcripts-tmp')
mkdirSync(transcriptUploadDir, { recursive: true })
const transcriptUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, transcriptUploadDir),
    filename: (_req, file, cb) => {
      const ts = Date.now()
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${ts}-${safe}`)
    }
  }),
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.docx')) cb(null, true)
    else cb(new Error('Only .docx files are supported'))
  }
})

// ---------------------------------------------------------------------------
// Helpers for the ingest-transcript route
// ---------------------------------------------------------------------------
function avgNums(...vals) {
  const valid = vals.map(Number).filter(n => !isNaN(n) && n != null)
  if (!valid.length) return null
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10
}

function deriveRiskLevelFromExtraction(extraction) {
  const level = (extraction?.investor_reaction?.investor_interest_level || '').toLowerCase()
  if (!level) return null
  if (level.includes('high')) return 'Low'
  if (level.includes('medium')) return 'Medium'
  if (level.includes('low')) return 'High'
  return null
}

function inferDateFromFilename(name) {
  const m = name.match(/(\d{4})_(\d{2})_(\d{2})/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

// POST /deals/:id/ingest-transcript
// Upload a transcript and force-link it to a specific deal (bypasses company detection).
router.post(
  '/:id/ingest-transcript',
  transcriptUpload.single('transcript'),
  async (req, res) => {
    const { id } = req.params
    const file = req.file
    if (!file) return res.status(400).json({ error: 'No file uploaded' })

    const cleanup = () => unlink(file.path, () => { })

    try {
      // 1. Verify the deal exists
      const dealRows = await sql`SELECT * FROM deals WHERE id = ${id} LIMIT 1`
      const existingDeal = dealRows[0]
      if (!existingDeal) {
        cleanup()
        return res.status(404).json({ error: 'Deal not found' })
      }

      // 2. Read text from docx
      const buffer = readFileSync(file.path)
      const { value: transcript } = await mammoth.extractRawText({ buffer })
      if (!transcript?.trim()) {
        cleanup()
        return res.status(422).json({ error: 'Could not extract text from the uploaded file' })
      }

      // 3. Extract deal info + embed in parallel
      const [extraction, embedding] = await Promise.all([
        extractDealFromTranscript({ transcript }),
        embed(transcript)
      ])

      const meetingDate = extraction.meeting_date || inferDateFromFilename(file.originalname) || null
      const vectorStr = formatVector(embedding)
      const companyDomain = pickBestNonWehDomainFromTranscript(transcript)

      // 4. Upsert a meetings row (skip if same filename already ingested)
      const existingMeeting = await sql`
        SELECT id FROM meetings WHERE drive_file_id = ${file.originalname} LIMIT 1
      `
      if (!existingMeeting[0]) {
        await sql`
          INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding)
          VALUES (${file.originalname}, ${file.originalname}, ${transcript}, ${vectorStr}::vector)
        `
      }

      // 5. Average conviction score with existing
      const mergedConviction = avgNums(
        existingDeal.conviction_score,
        extraction.deal_decision?.conviction_score
      )

      // 6. Merge extracted fields into the deal row (new transcript wins; blanks fall back to existing)
      const newExciting = extraction.deal_decision?.why_exciting || null
      const newRisks = extraction.deal_decision?.risks || null
      const newPass = extraction.deal_decision?.reasons_pass || null
      const newWatch = extraction.deal_decision?.reasons_watch || null
      const newAction = extraction.deal_decision?.action_required || null

      await sql`
        UPDATE deals SET
          exciting_reason   = COALESCE(${newExciting},   exciting_reason),
          risks             = COALESCE(${newRisks},      risks),
          pass_reasons      = COALESCE(${newPass},       pass_reasons),
          watch_reasons     = COALESCE(${newWatch},      watch_reasons),
          action_required   = COALESCE(${newAction},     action_required),
          poc               = COALESCE(poc,              ${extraction.poc || null}),
          sector            = COALESCE(sector,           ${extraction.sector || null}),
          founder_name      = COALESCE(founder_name,     ${extraction.founder_name || null}),
          company_domain    = COALESCE(company_domain,   ${companyDomain}),
          conviction_score  = ${mergedConviction},
          meeting_date      = COALESCE(meeting_date,     ${meetingDate}),
          risk_level        = COALESCE(risk_level,       ${deriveRiskLevelFromExtraction(extraction)}),
          source_file_name  = COALESCE(source_file_name, ${file.originalname}),
          updated_at        = now()
        WHERE id = ${id}
      `

      // 7. Insert a new deal_insights row for this transcript
      await sql`
        INSERT INTO deal_insights (deal_id, meeting_outcome, founder_pitch, business_model_signals,
          market_signals, investor_reaction, supporting_quotes, raw_payload)
        VALUES (
          ${id},
          ${JSON.stringify(extraction.meeting_outcome ?? {})},
          ${JSON.stringify(extraction.founder_pitch ?? {})},
          ${JSON.stringify(extraction.business_model_signals ?? {})},
          ${JSON.stringify(extraction.market_signals ?? {})},
          ${JSON.stringify(extraction.investor_reaction ?? {})},
          ${JSON.stringify(extraction.supporting_quotes ?? {})},
          ${JSON.stringify(extraction)}
        )
      `

      // 8. Re-score the founder with the new transcript data
      await scoreAndSaveFounder({ dealId: id, transcript, extraction })

      cleanup()
      return res.json({
        mode: 'linked',
        dealId: id,
        company: existingDeal.company
      })
    } catch (err) {
      cleanup()
      console.error('Error ingesting transcript for deal:', err)
      return res.status(500).json({ error: err.message || 'Failed to ingest transcript' })
    }
  }
)

// POST /deals/ingest-transcript
// Accepts a single .docx, runs full ingestion pipeline, merges if company exists.
router.post(
  '/ingest-transcript',
  transcriptUpload.single('transcript'),
  async (req, res) => {
    const file = req.file
    if (!file) return res.status(400).json({ error: 'No file uploaded' })

    const cleanup = () => unlink(file.path, () => { })

    try {
      // 1. Read text from docx
      const buffer = readFileSync(file.path)
      const { value: transcript } = await mammoth.extractRawText({ buffer })
      if (!transcript?.trim()) {
        cleanup()
        return res.status(422).json({ error: 'Could not extract text from the uploaded file' })
      }

      // 2. Extract deal info + embed in parallel
      const [extraction, embedding] = await Promise.all([
        extractDealFromTranscript({ transcript }),
        embed(transcript)
      ])

      const companyDomain = pickBestNonWehDomainFromTranscript(transcript)
      const extractedCompany = extraction.company || ''
      const companyMissing = isCompanyNameMissing(extractedCompany)
      const resolvedCompanyName = await resolveCompanyNameFallback({
        company: extraction.company,
        founderName: extraction.founder_name
      })
      const meetingDate = extraction.meeting_date || inferDateFromFilename(file.originalname) || null
      const vectorStr = formatVector(embedding)

      // 3. Check if company already exists using production-safe identity logic
      const identityDecision = await evaluateDealIdentity({
        extractedCompany,
        companyDomain,
        companyMissing
      })

      let existingDeal = null
      if (identityDecision.decision === 'resolved' && identityDecision.resolvedDealId) {
        const byId = await sql`
          SELECT * FROM deals WHERE id = ${identityDecision.resolvedDealId} LIMIT 1
        `
        existingDeal = byId[0] ?? null
      }

      // 4a. MERGE path — company already exists
      if (existingDeal) {
        const dealId = existingDeal.id

        // Upsert meeting row
        const existingMeeting = await sql`
          SELECT id FROM meetings WHERE drive_file_id = ${file.originalname} LIMIT 1
        `
        if (!existingMeeting[0]) {
          await sql`
            INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding)
            VALUES (${file.originalname}, ${file.originalname}, ${transcript}, ${vectorStr}::vector)
          `
        }

        // Average numeric scores
        const mergedConviction = avgNums(
          existingDeal.conviction_score,
          extraction.deal_decision?.conviction_score
        )

        // New transcript text wins; fill blanks from existing
        const newExciting = extraction.deal_decision?.why_exciting || null
        const newRisks = extraction.deal_decision?.risks || null
        const newPass = extraction.deal_decision?.reasons_pass || null
        const newWatch = extraction.deal_decision?.reasons_watch || null
        const newAction = extraction.deal_decision?.action_required || null

        await sql`
          UPDATE deals SET
            exciting_reason   = COALESCE(${newExciting},   exciting_reason),
            risks             = COALESCE(${newRisks},      risks),
            pass_reasons      = COALESCE(${newPass},       pass_reasons),
            watch_reasons     = COALESCE(${newWatch},      watch_reasons),
            action_required   = COALESCE(${newAction},     action_required),
            poc               = COALESCE(poc,              ${extraction.poc || null}),
            sector            = COALESCE(sector,           ${extraction.sector || null}),
            founder_name      = COALESCE(founder_name,     ${extraction.founder_name || null}),
            company_domain    = COALESCE(company_domain,   ${companyDomain}),
            conviction_score  = ${mergedConviction},
            meeting_date      = COALESCE(meeting_date,     ${meetingDate}),
            risk_level        = COALESCE(risk_level,       ${deriveRiskLevelFromExtraction(extraction)}),
            source_file_name  = COALESCE(source_file_name, ${file.originalname}),
            updated_at        = now()
          WHERE id = ${dealId}
        `

        // Add new deal_insights row for this transcript
        await sql`
          INSERT INTO deal_insights (deal_id, meeting_outcome, founder_pitch, business_model_signals,
            market_signals, investor_reaction, supporting_quotes, raw_payload)
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

        // Re-score founder and merge with existing score
        await scoreAndSaveFounder({ dealId, transcript, extraction })

        cleanup()
        return res.json({
          mode: 'merged',
          dealId,
          company: existingDeal.company
        })
      }

      // 4b. CREATE path — new company
      const dealRows = await sql`
        INSERT INTO deals (
          company, company_domain, date, poc, sector, founder_name,
          meeting_date, business_model, status, stage, risk_level,
          exciting_reason, risks, conviction_score, pass_reasons,
          watch_reasons, action_required, source_file_name
        ) VALUES (
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
          ${deriveRiskLevelFromExtraction(extraction)},
          ${extraction.deal_decision?.why_exciting || null},
          ${extraction.deal_decision?.risks || null},
          ${extraction.deal_decision?.conviction_score ?? null},
          ${extraction.deal_decision?.reasons_pass || null},
          ${extraction.deal_decision?.reasons_watch || null},
          ${extraction.deal_decision?.action_required || null},
          ${file.originalname}
        )
        RETURNING *
      `
      const newDeal = dealRows[0]

      await sql`
        INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding)
        VALUES (${file.originalname}, ${file.originalname}, ${transcript}, ${vectorStr}::vector)
      `

      await sql`
        INSERT INTO deal_insights (deal_id, meeting_outcome, founder_pitch, business_model_signals,
          market_signals, investor_reaction, supporting_quotes, raw_payload)
        VALUES (
          ${newDeal.id},
          ${JSON.stringify(extraction.meeting_outcome ?? {})},
          ${JSON.stringify(extraction.founder_pitch ?? {})},
          ${JSON.stringify(extraction.business_model_signals ?? {})},
          ${JSON.stringify(extraction.market_signals ?? {})},
          ${JSON.stringify(extraction.investor_reaction ?? {})},
          ${JSON.stringify(extraction.supporting_quotes ?? {})},
          ${JSON.stringify(extraction)}
        )
      `

      await scoreAndSaveFounder({ dealId: newDeal.id, transcript, extraction })

      cleanup()
      let ambiguityId = null
      if (identityDecision.decision === 'ambiguous') {
        const ambiguity = await createDealIdentityAmbiguity({
          sourceType: 'upload',
          sourceFileId: file.originalname,
          sourceFileName: file.originalname,
          extractedCompany: extraction.company || null,
          normalizedCompany: normalizeCompanyName(extraction.company),
          extractedDomain: companyDomain,
          candidateDealIds: identityDecision.candidateDeals.map((deal) => deal.id),
          pendingDealId: newDeal.id,
          payload: {
            reason: identityDecision.reason,
            founder_name: extraction.founder_name || null
          }
        })
        ambiguityId = ambiguity.id
      }

      return res.status(201).json({
        mode: identityDecision.decision === 'ambiguous' ? 'ambiguous' : 'created',
        dealId: newDeal.id,
        company: newDeal.company,
        ambiguityId
      })
    } catch (err) {
      cleanup()
      console.error('Error ingesting transcript:', err)
      return res.status(500).json({ error: err.message || 'Failed to ingest transcript' })
    }
  }
)


async function fetchDealBundle(id) {
  // First confirm the deal exists
  const dealRows = await sql`
    SELECT *
    FROM deals
    WHERE id = ${id}
    LIMIT 1
  `
  const deal = dealRows[0] ?? null
  if (!deal) return null

  // Fire all 5 sub-queries in parallel — each is independent
  const [softRows, hardRows, finalRows, insightsRows, fileRows] = await Promise.all([
    sql`
      SELECT *
      FROM founder_soft_scores
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT *
      FROM founder_hard_scores
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT *
      FROM founder_final_scores
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT *
      FROM deal_insights
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT id, file_name, stored_path, mime_type, size, uploaded_at
      FROM deal_files
      WHERE deal_id = ${id}
      ORDER BY uploaded_at DESC
    `
  ])

  return {
    deal,
    softScore: softRows[0] ?? null,
    hardScore: hardRows[0] ?? null,
    finalScore: finalRows[0] ?? null,
    insights: insightsRows[0] ?? null,
    files: fileRows
  }
}

router.post('/', async (req, res) => {
  try {
    const {
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
    } = req.body ?? {}

    if (!company) {
      return res.status(400).json({ error: 'company is required' })
    }

    const rows = await sql`
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
        ${date ?? null},
        ${poc ?? null},
        ${sector ?? null},
        ${status ?? null},
        ${exciting_reason ?? null},
        ${risks ?? null},
        ${conviction_score ?? null},
        ${pass_reasons ?? null},
        ${watch_reasons ?? null},
        ${action_required ?? null}
      )
      RETURNING *
    `

    res.status(201).json(rows[0])
  } catch (err) {
    console.error('Error creating deal', err)
    res.status(500).json({ error: 'Failed to create deal' })
  }
})

router.get('/', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT *
      FROM deals
      ORDER BY created_at DESC
    `
    res.json(rows)
  } catch (err) {
    console.error('Error fetching deals', err)
    res.status(500).json({ error: 'Failed to fetch deals' })
  }
})

router.post('/merge', async (req, res) => {
  const dealIds = req.body?.dealIds
  try {
    const summary = await mergeDealsTransactional(poolRef, dealIds)
    return res.json(summary)
  } catch (err) {
    if (err instanceof DealMergeError) {
      return res.status(err.status).json({ error: err.message })
    }
    console.error('Error merging deals', err)
    return res.status(500).json({ error: 'Failed to merge deals' })
  }
})

router.get('/ambiguities/count', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT COUNT(*)::int AS count
      FROM deal_identity_ambiguities
      WHERE status = 'pending'
    `
    return res.json({ count: rows[0]?.count ?? 0 })
  } catch (err) {
    console.error('Error fetching deal ambiguity count', err)
    return res.status(500).json({ error: 'Failed to fetch ambiguity count' })
  }
})

router.get('/ambiguities', async (req, res) => {
  const status = req.query?.status || 'pending'
  try {
    const rows = await sql`
      SELECT *
      FROM deal_identity_ambiguities
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT 100
    `
    const ids = new Set()
    for (const row of rows) {
      if (row.pending_deal_id) ids.add(String(row.pending_deal_id))
      const candidates = Array.isArray(row.candidate_deal_ids) ? row.candidate_deal_ids : []
      for (const id of candidates) ids.add(String(id))
    }
    const allIds = [...ids]
    const dealRows = allIds.length
      ? await sql`SELECT id, company, company_domain, status, updated_at FROM deals WHERE id = ANY(${allIds}::uuid[])`
      : []
    const byId = new Map(dealRows.map((deal) => [String(deal.id), deal]))
    const items = rows.map((row) => {
      const candidateIds = Array.isArray(row.candidate_deal_ids) ? row.candidate_deal_ids : []
      return {
        ...row,
        pendingDeal: row.pending_deal_id ? (byId.get(String(row.pending_deal_id)) ?? null) : null,
        candidateDeals: candidateIds.map((id) => byId.get(String(id))).filter(Boolean)
      }
    })
    return res.json({ items })
  } catch (err) {
    console.error('Error fetching deal ambiguities', err)
    return res.status(500).json({ error: 'Failed to fetch ambiguities' })
  }
})

router.post('/ambiguities/:id/resolve', async (req, res) => {
  const { id } = req.params
  const { action, dealId, resolvedBy } = req.body ?? {}
  if (!action) return res.status(400).json({ error: 'action is required' })

  try {
    const ambiguityRows = await sql`
      SELECT *
      FROM deal_identity_ambiguities
      WHERE id = ${id}
      LIMIT 1
    `
    const ambiguity = ambiguityRows[0]
    if (!ambiguity) return res.status(404).json({ error: 'Ambiguity not found' })
    if (ambiguity.status !== 'pending') {
      return res.status(400).json({ error: 'Ambiguity is already resolved' })
    }

    if (action === 'merge_into_existing') {
      if (!dealId) return res.status(400).json({ error: 'dealId is required for merge action' })
      if (!ambiguity.pending_deal_id) {
        return res.status(400).json({ error: 'No pending deal is attached to this ambiguity' })
      }

      const summary = await mergeDealsTransactional(
        poolRef,
        [ambiguity.pending_deal_id, dealId],
        { preferredPrimaryId: dealId }
      )

      await sql`
        UPDATE deal_identity_ambiguities
        SET
          status = 'resolved',
          resolved_deal_id = ${summary.primaryDealId},
          resolution_method = 'merge_into_existing',
          resolved_by = ${resolvedBy ?? null},
          resolved_at = now()
        WHERE id = ${id}
      `
      return res.json({ ok: true, action, summary })
    }

    if (action === 'ignore') {
      await sql`
        UPDATE deal_identity_ambiguities
        SET
          status = 'ignored',
          resolution_method = 'ignore',
          resolved_by = ${resolvedBy ?? null},
          resolved_at = now()
        WHERE id = ${id}
      `
      return res.json({ ok: true, action })
    }

    return res.status(400).json({ error: 'Unsupported action' })
  } catch (err) {
    if (err instanceof DealMergeError) {
      return res.status(err.status).json({ error: err.message })
    }
    console.error('Error resolving deal ambiguity', err)
    return res.status(500).json({ error: 'Failed to resolve ambiguity' })
  }
})

router.get('/:id/meeting', async (req, res) => {
  const { id } = req.params
  try {
    const rows = await sql`
      SELECT
        dm.id,
        dm.deal_id,
        dm.meeting_date,
        d.company,
        d.sector,
        d.poc,
        d.status,
        d.conviction_score,
        d.exciting_reason,
        d.risks,
        d.pass_reasons,
        d.watch_reasons,
        d.action_required
      FROM deal_meetings dm
      JOIN deals d ON dm.deal_id = d.id
      WHERE dm.deal_id = ${id}
      LIMIT 1
    `
    const meeting = rows[0] ?? null
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found for this deal' })
    }
    return res.json(meeting)
  } catch (err) {
    console.error('Error fetching deal meeting', err)
    return res.status(500).json({ error: 'Failed to fetch deal meeting' })
  }
})

router.post('/:id/meeting', async (req, res) => {
  const { id } = req.params
  const {
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
  } = req.body ?? {}

  try {
    const existingDealRows = await sql`
      SELECT id, company
      FROM deals
      WHERE id = ${id}
      LIMIT 1
    `
    const deal = existingDealRows[0]
    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' })
    }

    const existingMeetingRows = await sql`
      SELECT id
      FROM deal_meetings
      WHERE deal_id = ${id}
      LIMIT 1
    `
    if (existingMeetingRows[0]) {
      return res.status(400).json({ error: 'Meeting already exists for this deal' })
    }

    const rows = await sql`
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
        ${meeting_date ?? null},
        ${poc ?? null},
        ${sector ?? null},
        ${status ?? null},
        ${exciting_reason ?? null},
        ${risks ?? null},
        ${conviction_score ?? null},
        ${pass_reasons ?? null},
        ${watch_reasons ?? null},
        ${action_required ?? null}
      )
      RETURNING *
    `

    // Keep deals table synchronized for meeting note fields (like we do for PATCH)
    await sql`
      UPDATE deals
      SET 
        status = COALESCE(${status ?? null}, status),
        exciting_reason = COALESCE(${exciting_reason ?? null}, exciting_reason),
        risks = COALESCE(${risks ?? null}, risks),
        conviction_score = COALESCE(${conviction_score ?? null}, conviction_score),
        pass_reasons = COALESCE(${pass_reasons ?? null}, pass_reasons),
        watch_reasons = COALESCE(${watch_reasons ?? null}, watch_reasons),
        action_required = COALESCE(${action_required ?? null}, action_required),
        updated_at = now()
      WHERE id = ${deal.id}
    `.catch(e => console.error('Error syncing to deals:', e))

    return res.status(201).json(rows[0])
  } catch (err) {
    console.error('Error creating deal meeting', err)
    return res.status(500).json({ error: 'Failed to create deal meeting' })
  }
})

router.patch('/:id/meeting', async (req, res) => {
  const { id } = req.params
  const patch = req.body ?? {}
  const entries = Object.entries(patch)
  if (entries.length === 0) {
    return res.status(400).json({ error: 'No fields to update' })
  }

  try {
    const existingRows = await sql`
      SELECT *
      FROM deal_meetings
      WHERE deal_id = ${id}
      LIMIT 1
    `
    const existing = existingRows[0]
    if (!existing) {
      return res.status(404).json({ error: 'Meeting not found for this deal' })
    }

    const setFragments = []
    const values = []
    entries.forEach(([key, value], index) => {
      setFragments.push(`${key} = $${index + 1}`)
      values.push(value)
    })

    const text = `
      UPDATE deal_meetings
      SET ${setFragments.join(', ')}, updated_at = now()
      WHERE deal_id = $${values.length + 1}
      RETURNING *
    `
    const result = await poolRef.query(text, [...values, id])
    const updated = result.rows[0]
    if (!updated) {
      return res.status(404).json({ error: 'Meeting not found for this deal' })
    }

    // Keep deals table synchronized for meeting note fields
    const dealSyncText = `
      UPDATE deals
      SET ${setFragments.join(', ')}, updated_at = now()
      WHERE id = $${values.length + 1}
    `
    // Execute but ignore errors if some patch key doesn't map to deals (they all should)
    await poolRef.query(dealSyncText, [...values, id]).catch(e => console.error('Error syncing to deals:', e))

    return res.json(updated)
  } catch (err) {
    console.error('Error updating deal meeting', err)
    return res.status(500).json({ error: 'Failed to update deal meeting' })
  }
})

router.delete('/:id/meeting', async (req, res) => {
  const { id } = req.params
  try {
    const existingRows = await sql`
      SELECT id
      FROM deal_meetings
      WHERE deal_id = ${id}
      LIMIT 1
    `
    const existing = existingRows[0]
    if (!existing) {
      return res.status(404).json({ error: 'Meeting not found for this deal' })
    }

    await sql`
      DELETE FROM deal_meetings
      WHERE deal_id = ${id}
    `
    return res.status(204).end()
  } catch (err) {
    console.error('Error deleting deal meeting', err)
    return res.status(500).json({ error: 'Failed to delete deal meeting' })
  }
})

router.get('/:id', async (req, res) => {
  const { id } = req.params
  try {
    const bundle = await fetchDealBundle(id)
    if (!bundle) {
      return res.status(404).json({ error: 'Deal not found' })
    }
    res.json(bundle)
  } catch (err) {
    console.error('Error fetching deal', err)
    res.status(500).json({ error: 'Failed to fetch deal' })
  }
})

router.patch('/:id', async (req, res) => {
  const { id } = req.params
  const patch = req.body ?? {}
  const dealEntries = Object.entries(patch).filter(([key]) =>
    DEAL_PATCH_FIELDS.includes(key)
  )
  const softEntries = Object.entries(patch).filter(([key]) =>
    SOFT_PATCH_FIELDS.includes(key)
  )
  const hardEntries = Object.entries(patch).filter(([key]) =>
    HARD_PATCH_FIELDS.includes(key)
  )

  if (dealEntries.length === 0 && softEntries.length === 0 && hardEntries.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  try {
    if (dealEntries.length > 0) {
      const setFragments = []
      const values = []
      dealEntries.forEach(([key, value], index) => {
        setFragments.push(`${key} = $${index + 1}`)
        values.push(value)
      })
      const text = `
        UPDATE deals
        SET ${setFragments.join(', ')}, updated_at = now()
        WHERE id = $${values.length + 1}
        RETURNING *
      `
      const result = await poolRef.query(text, [...values, id])
      const rows = result.rows
      if (!rows[0]) {
        return res.status(404).json({ error: 'Deal not found' })
      }
    }

    const shouldUpdateScore = softEntries.length > 0 || hardEntries.length > 0
    if (shouldUpdateScore) {
      const softRows = await sql`
        SELECT *
        FROM founder_soft_scores
        WHERE deal_id = ${id}
        ORDER BY created_at DESC
        LIMIT 1
      `

      const hardRows = await sql`
        SELECT *
        FROM founder_hard_scores
        WHERE deal_id = ${id}
        ORDER BY created_at DESC
        LIMIT 1
      `

      const finalRows = await sql`
        SELECT *
        FROM founder_final_scores
        WHERE deal_id = ${id}
        ORDER BY created_at DESC
        LIMIT 1
      `

      const existingSoft = softRows[0] ?? null
      const existingHard = hardRows[0] ?? null
      const existingFinal = finalRows[0] ?? null
      const softPatch = Object.fromEntries(softEntries)
      const hardPatch = Object.fromEntries(hardEntries)

      const resilience =
        softPatch.resilience !== undefined
          ? clampScore(softPatch.resilience)
          : Number(existingSoft?.resilience ?? 0)
      const ambition =
        softPatch.ambition !== undefined
          ? clampScore(softPatch.ambition)
          : Number(existingSoft?.ambition ?? 0)
      const self_awareness =
        softPatch.self_awareness !== undefined
          ? clampScore(softPatch.self_awareness)
          : Number(existingSoft?.self_awareness ?? 0)
      const domain_fit =
        softPatch.domain_fit !== undefined
          ? clampScore(softPatch.domain_fit)
          : Number(existingSoft?.domain_fit ?? 0)
      const storytelling =
        softPatch.storytelling !== undefined
          ? clampScore(softPatch.storytelling)
          : Number(existingSoft?.storytelling ?? 0)
      const archetype =
        softPatch.archetype !== undefined
          ? String(softPatch.archetype ?? '').trim() || null
          : existingSoft?.archetype ?? null

      const education_tier =
        hardPatch.education_tier !== undefined
          ? clampScore(hardPatch.education_tier)
          : Number(existingHard?.education_tier ?? 0)
      const domain_work_experience =
        hardPatch.domain_work_experience !== undefined
          ? clampScore(hardPatch.domain_work_experience)
          : Number(existingHard?.domain_work_experience ?? 0)
      const seniority_of_roles =
        hardPatch.seniority_of_roles !== undefined
          ? clampScore(hardPatch.seniority_of_roles)
          : Number(existingHard?.seniority_of_roles ?? 0)
      const previous_startup_experience =
        hardPatch.previous_startup_experience !== undefined
          ? clampScore(hardPatch.previous_startup_experience)
          : Number(existingHard?.previous_startup_experience ?? 0)

      const softWeightedScore = computeWeightedScore(
        {
          resilience,
          ambition,
          self_awareness,
          domain_fit,
          storytelling
        },
        SOFT_WEIGHTS
      )

      const hardWeightedScore = computeWeightedScore(
        {
          education_tier,
          domain_work_experience,
          seniority_of_roles,
          previous_startup_experience
        },
        HARD_WEIGHTS
      )

      const finalScore = computeFinalScore(hardWeightedScore, softWeightedScore)
      const ddResult = getDDRecommendation(finalScore)

      if (existingSoft) {
        await sql`
          UPDATE founder_soft_scores
          SET
            resilience = ${resilience},
            ambition = ${ambition},
            self_awareness = ${self_awareness},
            domain_fit = ${domain_fit},
            storytelling = ${storytelling},
            soft_weighted_score = ${softWeightedScore},
            archetype = ${archetype}
          WHERE id = ${existingSoft.id}
        `
      } else {
        await sql`
          INSERT INTO founder_soft_scores (
            deal_id,
            resilience,
            ambition,
            self_awareness,
            domain_fit,
            storytelling,
            soft_weighted_score,
            archetype,
            evidence_json
          )
          VALUES (
            ${id},
            ${resilience},
            ${ambition},
            ${self_awareness},
            ${domain_fit},
            ${storytelling},
            ${softWeightedScore},
            ${archetype},
            ${JSON.stringify({})}
          )
        `
      }

      if (existingHard) {
        await sql`
          UPDATE founder_hard_scores
          SET
            education_tier = ${education_tier},
            domain_work_experience = ${domain_work_experience},
            seniority_of_roles = ${seniority_of_roles},
            previous_startup_experience = ${previous_startup_experience},
            hard_weighted_score = ${hardWeightedScore}
          WHERE id = ${existingHard.id}
        `
      } else {
        await sql`
          INSERT INTO founder_hard_scores (
            deal_id,
            education_tier,
            domain_work_experience,
            seniority_of_roles,
            previous_startup_experience,
            hard_weighted_score
          )
          VALUES (
            ${id},
            ${education_tier},
            ${domain_work_experience},
            ${seniority_of_roles},
            ${previous_startup_experience},
            ${hardWeightedScore}
          )
        `
      }

      if (existingFinal) {
        await sql`
          UPDATE founder_final_scores
          SET
            hard_weighted_score = ${hardWeightedScore},
            soft_weighted_score = ${softWeightedScore},
            final_score = ${finalScore},
            dd_recommendation = ${ddResult.recommendation},
            scored_at = now()
          WHERE id = ${existingFinal.id}
        `
      } else {
        await sql`
          INSERT INTO founder_final_scores (
            deal_id,
            hard_weighted_score,
            soft_weighted_score,
            final_score,
            dd_recommendation,
            scored_at
          )
          VALUES (
            ${id},
            ${hardWeightedScore},
            ${softWeightedScore},
            ${finalScore},
            ${ddResult.recommendation},
            now()
          )
        `
      }

      await sql`
        UPDATE deals
        SET
          founder_soft_score = ${softWeightedScore},
          founder_hard_score = ${hardWeightedScore},
          founder_final_score = ${finalScore},
          dd_recommendation = ${ddResult.recommendation},
          conviction_score = COALESCE(conviction_score, ${finalScore}),
          updated_at = now()
        WHERE id = ${id}
      `
    }

    const bundle = await fetchDealBundle(id)
    if (!bundle) {
      return res.status(404).json({ error: 'Deal not found' })
    }
    res.json(bundle)
  } catch (err) {
    console.error('Error updating deal', err)
    res.status(500).json({ error: 'Failed to update deal' })
  }
})

router.get('/:id/score', async (req, res) => {
  const { id } = req.params
  try {
    const softRows = await sql`
      SELECT *
      FROM founder_soft_scores
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `
    const softScore = softRows[0] ?? null

    const hardRows = await sql`
      SELECT *
      FROM founder_hard_scores
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `
    const hardScore = hardRows[0] ?? null

    const finalRows = await sql`
      SELECT *
      FROM founder_final_scores
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `
    const finalScore = finalRows[0] ?? null

    if (!softScore && !hardScore && !finalScore) {
      return res
        .status(404)
        .json({ error: 'No founder score for this deal yet' })
    }

    res.json({ softScore, hardScore, finalScore })
  } catch (err) {
    console.error('Error fetching deal score', err)
    res.status(500).json({ error: 'Failed to fetch deal score' })
  }
})

router.post('/:id/score', async (req, res) => {
  const { id } = req.params
  const { transcript, hardFacts, extraction } = req.body ?? {}

  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' })
  }

  try {
    const result = await scoreAndSaveFounder({
      dealId: id,
      transcript,
      hardFacts,
      extraction
    })

    res.status(201).json(result)
  } catch (err) {
    console.error('Error scoring founder', err)
    res.status(500).json({ error: 'Failed to score founder for this deal' })
  }
})

router.get('/:id/insights', async (req, res) => {
  const { id } = req.params
  try {
    const insightsRows = await sql`
      SELECT *
      FROM deal_insights
      WHERE deal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `
    const insights = insightsRows[0] ?? null
    if (!insights) {
      return res
        .status(404)
        .json({ error: 'No insights for this deal yet' })
    }
    res.json({ insights })
  } catch (err) {
    console.error('Error fetching deal insights', err)
    res.status(500).json({ error: 'Failed to fetch deal insights' })
  }
})

router.post('/:id/files', upload.array('files'), async (req, res) => {
  const { id } = req.params
  try {
    const existing = await sql`
      SELECT id FROM deals WHERE id = ${id} LIMIT 1
    `
    if (!existing[0]) {
      return res.status(404).json({ error: 'Deal not found' })
    }
    const files = req.files || []
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded' })
    }
    const inserted = []
    // eslint-disable-next-line no-restricted-syntax
    for (const f of files) {
      const stored = basename(f.path)
      const rows = await sql`
        INSERT INTO deal_files (deal_id, file_name, stored_path, mime_type, size)
        VALUES (${id}, ${f.originalname}, ${stored}, ${f.mimetype ?? null}, ${f.size ?? null})
        RETURNING id, file_name, stored_path, mime_type, size, uploaded_at
      `
      if (rows[0]) inserted.push(rows[0])
    }
    return res.status(201).json({ files: inserted })
  } catch (err) {
    console.error('Error uploading deal files', err)
    return res.status(500).json({ error: 'Failed to upload files' })
  }
})

router.get('/:id/files', async (req, res) => {
  const { id } = req.params
  try {
    const files = await sql`
      SELECT id, file_name, stored_path, mime_type, size, uploaded_at
      FROM deal_files
      WHERE deal_id = ${id}
      ORDER BY uploaded_at DESC
    `
    return res.json({ files })
  } catch (err) {
    console.error('Error fetching deal files', err)
    return res.status(500).json({ error: 'Failed to fetch deal files' })
  }
})

router.delete('/:dealId/files/:fileId', async (req, res) => {
  const { dealId, fileId } = req.params
  try {
    const rows = await sql`
      SELECT id, stored_path
      FROM deal_files
      WHERE id = ${fileId} AND deal_id = ${dealId}
      LIMIT 1
    `
    const file = rows[0]
    if (!file) {
      return res.status(404).json({ error: 'File not found' })
    }
    const fullPath = join(uploadDir, file.stored_path)
    unlink(fullPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.warn('Failed to remove file from disk', err)
      }
    })
    await sql`
      DELETE FROM deal_files WHERE id = ${fileId}
    `
    return res.status(204).end()
  } catch (err) {
    console.error('Error deleting deal file', err)
    return res.status(500).json({ error: 'Failed to delete file' })
  }
})

router.post('/ingest-docs', async (req, res) => {
  const { limit, dryRun } = req.body ?? {}
  try {
    const result = await ingestDocs({
      limit: typeof limit === 'number' ? limit : undefined,
      dryRun: Boolean(dryRun)
    })
    res.json(result)
  } catch (err) {
    console.error('Error ingesting docs', err)
    res.status(500).json({ error: 'Failed to ingest docs' })
  }
})

export default router

