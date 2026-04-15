import { sql, formatVector } from '../db/neon.js'
import { embed } from './embeddings.js'
import { extractDealFromTranscript } from './dealExtraction.js'
import { mergeScoresForCompanyIdentity, scoreAndSaveFounder } from './founderScoring.js'
import { getDefaultDocsDir, listDocxFiles, readDocxFile } from './docxReader.js'
import {
  isCompanyNameMissing,
  normalizeCompanyName,
  pickBestNonWehDomainFromTranscript,
  resolveCompanyNameFallback
} from './companyIdentity.js'

async function findExistingMeeting(fileName) {
  const rows = await sql`
    SELECT id
    FROM meetings
    WHERE source_file_name = ${fileName}
    LIMIT 1
  `
  return rows[0] ?? null
}

async function findExistingDealBySourceFile(fileName) {
  const rows = await sql`
    SELECT id
    FROM deals
    WHERE source_file_name = ${fileName}
    LIMIT 1
  `
  return rows[0] ?? null
}

async function findExistingDealByCompanyName(companyName) {
  const normalized = normalizeCompanyName(companyName)
  if (!normalized) return null
  const rows = await sql`
    SELECT id
    FROM deals
    WHERE LOWER(TRIM(company)) = ${normalized}
    LIMIT 1
  `
  return rows[0] ?? null
}

async function findExistingDealByCompanyDomain(companyDomain) {
  if (!companyDomain) return null
  const rows = await sql`
    SELECT id
    FROM deals
    WHERE company_domain = ${companyDomain}
    LIMIT 1
  `
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

export async function ingestDocs({ limit, dryRun } = {}) {
  const docsDir = getDefaultDocsDir()
  const files = listDocxFiles(docsDir)
  const slice = typeof limit === 'number' && limit > 0 ? files.slice(0, limit) : files

  let processed = 0
  let skippedEmpty = 0
  let errors = 0

  for (const file of slice) {
    const existingMeeting = await findExistingMeeting(file.name)
    const existingDeal = await findExistingDealBySourceFile(file.name)

    // Skip if already ingested
    if (existingMeeting && existingDeal) {
      console.log(`Skipping ${file.name}: already ingested.`)
      continue
    }

    let doc
    try {
      doc = await readDocxFile(file)
    } catch (err) {
      console.warn(`Skipping ${file.name}: failed to read docx - ${err.message}`)
      errors += 1
      continue
    }

    const transcript = doc.text?.trim()
    if (!transcript) {
      console.warn(`Skipping ${file.name}: empty transcript`)
      skippedEmpty += 1
      continue
    }

    try {
      const extraction = await extractDealFromTranscript({ transcript })

      if (dryRun) {
        processed += 1
        continue
      }

      const extractedCompany = extraction.company || ''
      const companyMissing = isCompanyNameMissing(extractedCompany)
      const resolvedCompanyName = await resolveCompanyNameFallback({
        company: extraction.company,
        founderName: extraction.founder_name
      })
      const companyDomain = pickBestNonWehDomainFromTranscript(transcript)

      let meetingId = existingMeeting?.id
      if (!meetingId) {
        const embedding = await embed(transcript)
        const vectorStr = formatVector(embedding)
        const companyForMeeting = companyMissing ? null : (extraction.company || null)

        const meetingRows = await sql`
          INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding, company)
          VALUES (${file.name}, ${file.name}, ${transcript}, ${vectorStr}::vector, ${companyForMeeting})
          RETURNING id
        `
        meetingId = meetingRows[0].id
      }

      const meetingDate =
        extraction.meeting_date ||
        doc.metadata.meetingDate ||
        null

      let dealId = existingDeal?.id
      let matchedExistingIdentity = false

      if (!dealId) {
        const byName = !companyMissing
          ? await findExistingDealByCompanyName(extractedCompany)
          : null
        const byDomain = !byName && companyDomain
          ? await findExistingDealByCompanyDomain(companyDomain)
          : null
        const identityMatch = byName || byDomain
        if (identityMatch?.id) {
          dealId = identityMatch.id
          matchedExistingIdentity = true
        }
      }

      if (!dealId) {
        const dealRows = await sql`
          INSERT INTO deals (
            company,
            company_domain,
            date,
            poc,
            sector,
            founder_name,
            meeting_date,
            business_model,
            status,
            stage,
            risk_level,
            exciting_reason,
            risks,
            conviction_score,
            pass_reasons,
            watch_reasons,
            action_required,
            source_file_name
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
          RETURNING *
        `
        dealId = dealRows[0].id
      }

      await scoreAndSaveFounder({
        dealId,
        transcript,
        extraction
      })

      if (matchedExistingIdentity) {
        await mergeScoresForCompanyIdentity({
          dealId,
          companyName: companyMissing ? null : extractedCompany,
          companyDomain
        })
      }

      await sql`
        INSERT INTO deal_insights (
          deal_id,
          meeting_outcome,
          founder_pitch,
          business_model_signals,
          market_signals,
          investor_reaction,
          supporting_quotes,
          raw_payload
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

      processed += 1

      console.log(
        `Ingested meeting ${meetingId} into deal ${dealId} for file ${file.name}`
      )
    } catch (err) {
      console.error(`Failed to ingest ${file.name}:`, err)
      errors += 1
    }
  }

  return {
    processed,
    skippedEmpty,
    errors,
    totalFiles: slice.length
  }
}

