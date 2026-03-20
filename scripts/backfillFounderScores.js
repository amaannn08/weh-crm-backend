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
    // Best-effort mappings from legacy model dimensions.
    domain_work_experience: toNumberOrZero(legacySignals.technical_background),
    seniority_of_roles: toNumberOrZero(legacySignals.network_strength),
    previous_startup_experience: toNumberOrZero(
      legacySignals.previous_startup_experience
    )
  }
}

async function getLegacyRows() {
  return sql`
    SELECT
      d.id AS deal_id,
      fs.id AS legacy_score_id,
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
    FROM deals d
    JOIN LATERAL (
      SELECT *
      FROM founder_scores
      WHERE deal_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) fs ON true
    LEFT JOIN LATERAL (
      SELECT *
      FROM founder_signals
      WHERE deal_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) fsg ON true
  `
}

async function hasNewModelRows(dealId) {
  const rows = await sql`
    SELECT id
    FROM founder_final_scores
    WHERE deal_id = ${dealId}
    LIMIT 1
  `
  return Boolean(rows[0])
}

async function run() {
  const dryRun = process.argv.includes('--dry-run')
  await initSchema()

  const legacyRows = await getLegacyRows()

  let scanned = 0
  let migrated = 0
  let skippedAlreadyMigrated = 0

  for (const row of legacyRows) {
    scanned += 1
    const dealId = row.deal_id

    if (await hasNewModelRows(dealId)) {
      skippedAlreadyMigrated += 1
      continue
    }

    const softScores = {
      resilience: toNumberOrZero(row.resilience),
      ambition: toNumberOrZero(row.ambition),
      self_awareness: toNumberOrZero(row.self_awareness),
      domain_fit: toNumberOrZero(row.domain_fit),
      storytelling: toNumberOrZero(row.storytelling)
    }
    const softWeightedScore =
      row.weighted_score !== null && row.weighted_score !== undefined
        ? clampScore(row.weighted_score)
        : computeWeightedScore(softScores, SOFT_WEIGHTS)

    const hardScores = mapLegacyHardScores(row)
    const hardWeightedScore = computeWeightedScore(hardScores, HARD_WEIGHTS)
    const finalScore = computeFinalScore(hardWeightedScore, softWeightedScore)
    const dd = getDDRecommendation(finalScore)

    if (!dryRun) {
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
          ${dealId},
          ${softScores.resilience},
          ${softScores.ambition},
          ${softScores.self_awareness},
          ${softScores.domain_fit},
          ${softScores.storytelling},
          ${softWeightedScore},
          ${row.archetype ?? null},
          ${row.evidence_json ?? JSON.stringify({})}
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

    migrated += 1
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        scanned,
        migrated,
        skippedAlreadyMigrated
      },
      null,
      2
    )
  )
}

run().catch((err) => {
  console.error('Backfill founder scores failed:', err)
  process.exit(1)
})
