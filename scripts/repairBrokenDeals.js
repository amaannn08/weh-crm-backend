/**
 * repairBrokenDeals.js
 *
 * Finds all deals where deal_insights.raw_payload = {} (extraction silently failed),
 * re-runs extraction and founder scoring, and updates the deal record.
 *
 * Usage:
 *   node scripts/repairBrokenDeals.js
 */
import 'dotenv/config'
import { query, poolRef } from '../db/neon.js'
import { extractDealFromTranscript } from '../services/dealExtraction.js'
import { scoreAndSaveFounder } from '../services/founderScoring.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function run() {
  // 1. Find all deals with empty extraction
  const emptyDeals = await query(`
    SELECT d.id, d.company, d.source_file_name
    FROM deals d
    JOIN deal_insights di ON di.deal_id = d.id
    WHERE di.raw_payload::text = '{}'
    ORDER BY d.created_at ASC
  `)

  console.log(`\nFound ${emptyDeals.rows.length} deals with empty extraction. Starting repair...\n`)

  let repaired = 0
  let failed = 0

  for (const deal of emptyDeals.rows) {
    const dealId = deal.id
    const label = `[repair] ${deal.company} (${deal.source_file_name?.slice(0, 60)})`

    // Get meeting transcript
    const meetingRes = await query(
      `SELECT transcript FROM meetings WHERE source_file_name = $1 OR drive_file_id = (
        SELECT drive_file_id FROM drive_transcript_ingestion_status WHERE source_file_name = $1 LIMIT 1
      ) LIMIT 1`,
      [deal.source_file_name]
    )

    if (!meetingRes.rows.length || !meetingRes.rows[0].transcript) {
      console.warn(`${label}: No transcript found, skipping`)
      failed++
      continue
    }

    const transcript = meetingRes.rows[0].transcript

    try {
      // Re-run extraction
      console.log(`${label}: Running extraction...`)
      const extraction = await extractDealFromTranscript({ transcript })

      if (!extraction || Object.keys(extraction).length === 0) {
        console.warn(`${label}: Extraction returned empty object again, skipping`)
        failed++
        continue
      }

      // Update deal_insights
      await query('DELETE FROM deal_insights WHERE deal_id = $1', [dealId])
      await query(
        `INSERT INTO deal_insights (
          deal_id, meeting_outcome, founder_pitch, business_model_signals,
          market_signals, investor_reaction, supporting_quotes, raw_payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          dealId,
          JSON.stringify(extraction.meeting_outcome ?? {}),
          JSON.stringify(extraction.founder_pitch ?? {}),
          JSON.stringify(extraction.business_model_signals ?? {}),
          JSON.stringify(extraction.market_signals ?? {}),
          JSON.stringify(extraction.investor_reaction ?? {}),
          JSON.stringify(extraction.supporting_quotes ?? {}),
          JSON.stringify(extraction)
        ]
      )

      // Re-run founder scoring
      await scoreAndSaveFounder({ dealId, transcript, extraction })

      // Update deal main fields
      await query(
        `UPDATE deals
        SET
          founder_name = COALESCE(founder_name, $1),
          meeting_date = COALESCE(meeting_date, $2),
          date = COALESCE(date, $2),
          sector = COALESCE(sector, $3),
          exciting_reason = COALESCE(exciting_reason, $4),
          risks = COALESCE(risks, $5),
          conviction_score = CASE WHEN conviction_score = 0 THEN $6 ELSE conviction_score END,
          action_required = COALESCE(action_required, $7),
          updated_at = NOW()
        WHERE id = $8`,
        [
          extraction.founder_name || null,
          extraction.meeting_date || null,
          extraction.sector || null,
          extraction.deal_decision?.why_exciting || null,
          extraction.deal_decision?.risks || null,
          extraction.deal_decision?.conviction_score ?? 0,
          extraction.deal_decision?.action_required || null,
          dealId
        ]
      )

      console.log(`${label}: ✅ Repaired! company=${extraction.company}, sector=${extraction.sector}, founder=${extraction.founder_name}`)
      repaired++

      // Rate limit courtesy delay between calls
      await sleep(1500)
    } catch (err) {
      console.error(`${label}: ❌ Failed — ${err.message}`)
      failed++
      await sleep(2000)
    }
  }

  console.log(`\n=== Repair Complete ===`)
  console.log(`✅ Repaired: ${repaired}`)
  console.log(`❌ Failed:   ${failed}`)
  console.log(`📊 Total:    ${emptyDeals.rows.length}`)

  await poolRef.end()
  process.exit(0)
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
