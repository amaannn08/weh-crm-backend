import 'dotenv/config'
import { query, poolRef } from '../db/neon.js'
import { extractDealFromTranscript } from '../services/dealExtraction.js'
import { scoreAndSaveFounder } from '../services/founderScoring.js'

async function run() {
  const dealId = '123f4f65-1c51-4450-92de-f4b4b6d3622e'
  const m = await query("SELECT transcript FROM meetings WHERE source_file_name ILIKE '%metricsamp%'")
  if (!m.rows.length) {
    console.error('No meeting transcript found for metricsamp')
    process.exit(1)
  }
  const transcript = m.rows[0].transcript

  console.log('1. Extracting deal signals for Metricsamp...')
  const extraction = await extractDealFromTranscript({ transcript })

  console.log('2. Updating deal_insights...')
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

  console.log('3. Scoring founder for Metricsamp...')
  const scoreResult = await scoreAndSaveFounder({ dealId, transcript, extraction })
  console.log('Score result:', scoreResult)

  console.log('4. Updating deal main table...')
  await query(
    `UPDATE deals
    SET
      company = 'Metricsamp',
      founder_name = $1,
      meeting_date = $2,
      date = $2,
      sector = $3,
      exciting_reason = $4,
      risks = $5,
      conviction_score = $6,
      action_required = $7,
      updated_at = NOW()
    WHERE id = $8`,
    [
      extraction.founder_name || 'Ayush Sahoo',
      extraction.meeting_date || '2026-08-10',
      extraction.sector || 'AI / ML',
      extraction.deal_decision?.why_exciting || null,
      extraction.deal_decision?.risks || null,
      extraction.deal_decision?.conviction_score ?? 6,
      extraction.deal_decision?.action_required || null,
      dealId
    ]
  )

  const updatedDeal = await query(
    'SELECT id, company, founder_name, meeting_date, sector, founder_final_score, dd_recommendation FROM deals WHERE id = $1',
    [dealId]
  )
  console.log('Successfully updated Metricsamp deal:')
  console.log(updatedDeal.rows[0])

  await poolRef.end()
  process.exit(0)
}

run().catch((err) => {
  console.error('Error repairing Metricsamp:', err)
  process.exit(1)
})
