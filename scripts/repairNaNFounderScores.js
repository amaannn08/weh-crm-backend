import 'dotenv/config'
import { initSchema, sql } from '../db/neon.js'
import {
  clampScore,
  computeFinalScore,
  computeWeightedScore,
  getDDRecommendation,
  HARD_WEIGHTS,
  SOFT_WEIGHTS
} from '../services/founderScoring.js'

function toNumberOrZero(value) {
  if (value === null || value === undefined || value === '') return 0
  return clampScore(value)
}

function mapLegacyHardScores(legacySignals = {}) {
  return {
    education_tier: toNumberOrZero(legacySignals.education_tier),
    domain_work_experience: toNumberOrZero(legacySignals.technical_background),
    seniority_of_roles: toNumberOrZero(legacySignals.network_strength),
    previous_startup_experience: toNumberOrZero(
      legacySignals.previous_startup_experience
    )
  }
}

async function getNaNDeals() {
  return sql`
    SELECT DISTINCT d.id AS deal_id
    FROM deals d
    WHERE d.founder_hard_score::text = 'NaN'
      OR d.founder_final_score::text = 'NaN'
      OR EXISTS (
        SELECT 1
        FROM founder_hard_scores h
        WHERE h.deal_id = d.id
          AND h.hard_weighted_score::text = 'NaN'
      )
      OR EXISTS (
        SELECT 1
        FROM founder_final_scores f
        WHERE f.deal_id = d.id
          AND (
            f.final_score::text = 'NaN'
            OR f.hard_weighted_score::text = 'NaN'
            OR f.soft_weighted_score::text = 'NaN'
          )
      )
  `
}

async function getLatestLegacyForDeal(dealId) {
  const rows = await sql`
    SELECT
      fs.deal_id,
      fs.resilience,
      fs.ambition,
      fs.self_awareness,
      fs.domain_fit,
      fs.storytelling,
      fs.weighted_score,
      fs.archetype,
      fs.evidence_json,
      fsg.education_tier,
      fsg.previous_startup_experience,
      fsg.technical_background,
      fsg.network_strength
    FROM founder_scores fs
    LEFT JOIN LATERAL (
      SELECT *
      FROM founder_signals
      WHERE deal_id = fs.deal_id
      ORDER BY created_at DESC
      LIMIT 1
    ) fsg ON true
    WHERE fs.deal_id = ${dealId}
    ORDER BY fs.created_at DESC
    LIMIT 1
  `
  return rows[0] ?? null
}

async function repairDeal(dealId, dryRun) {
  const legacy = await getLatestLegacyForDeal(dealId)
  if (!legacy) return { status: 'skipped_no_legacy' }

  const softScores = {
    resilience: toNumberOrZero(legacy.resilience),
    ambition: toNumberOrZero(legacy.ambition),
    self_awareness: toNumberOrZero(legacy.self_awareness),
    domain_fit: toNumberOrZero(legacy.domain_fit),
    storytelling: toNumberOrZero(legacy.storytelling)
  }
  const softWeightedScore =
    legacy.weighted_score !== null && legacy.weighted_score !== undefined
      ? clampScore(legacy.weighted_score)
      : computeWeightedScore(softScores, SOFT_WEIGHTS)

  const hardScores = mapLegacyHardScores(legacy)
  const hardWeightedScore = computeWeightedScore(hardScores, HARD_WEIGHTS)
  const finalScore = computeFinalScore(hardWeightedScore, softWeightedScore)
  const dd = getDDRecommendation(finalScore)

  if (!dryRun) {
    await sql`
      DELETE FROM founder_hard_scores
      WHERE deal_id = ${dealId}
        AND hard_weighted_score::text = 'NaN'
    `
    await sql`
      DELETE FROM founder_final_scores
      WHERE deal_id = ${dealId}
        AND (
          final_score::text = 'NaN'
          OR hard_weighted_score::text = 'NaN'
          OR soft_weighted_score::text = 'NaN'
        )
    `

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
        ${dealId},
        ${hardScores.education_tier},
        ${hardScores.domain_work_experience},
        ${hardScores.seniority_of_roles},
        ${hardScores.previous_startup_experience},
        ${hardWeightedScore}
      )
    `

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
        ${dealId},
        ${hardWeightedScore},
        ${softWeightedScore},
        ${finalScore},
        ${dd.recommendation},
        now()
      )
    `

    await sql`
      UPDATE deals
      SET
        founder_soft_score = ${softWeightedScore},
        founder_hard_score = ${hardWeightedScore},
        founder_final_score = ${finalScore},
        dd_recommendation = ${dd.recommendation},
        conviction_score = COALESCE(conviction_score, ${finalScore}),
        updated_at = now()
      WHERE id = ${dealId}
    `
  }

  return { status: 'repaired' }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run')
  await initSchema()

  const nanDeals = await getNaNDeals()
  let scanned = 0
  let repaired = 0
  let skippedNoLegacy = 0

  for (const row of nanDeals) {
    scanned += 1
    const result = await repairDeal(row.deal_id, dryRun)
    if (result.status === 'repaired') repaired += 1
    if (result.status === 'skipped_no_legacy') skippedNoLegacy += 1
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        scanned,
        repaired,
        skippedNoLegacy
      },
      null,
      2
    )
  )
}

run().catch((err) => {
  console.error('Repair NaN founder scores failed:', err)
  process.exit(1)
})
