/**
 * recomputeFounderScores.js
 *
 * Recomputes soft_weighted_score, hard_weighted_score, final_score, and
 * dd_recommendation for every deal using the already-stored per-trait scores.
 *
 * This is needed after changing computeWeightedScore to include zero-scored
 * traits instead of silently skipping them.
 *
 * Usage:
 *   node --env-file=.env backend/scripts/recomputeFounderScores.js
 *   node --env-file=.env backend/scripts/recomputeFounderScores.js --dry-run
 */

import 'dotenv/config'
import { sql } from '../db/neon.js'
import {
    clampScore,
    computeWeightedScore,
    computeFinalScore,
    getDDRecommendation,
    SOFT_WEIGHTS,
    HARD_WEIGHTS
} from '../services/founderScoring.js'

const DRY_RUN = process.argv.includes('--dry-run')

async function getAllDealsWithScores() {
    return sql`
    SELECT
      d.id AS deal_id,
      -- soft
      fss.resilience,
      fss.ambition,
      fss.self_awareness,
      fss.domain_fit,
      fss.storytelling,
      -- hard
      fhs.education_tier,
      fhs.domain_work_experience,
      fhs.seniority_of_roles,
      fhs.previous_startup_experience
    FROM deals d
    JOIN LATERAL (
      SELECT resilience, ambition, self_awareness, domain_fit, storytelling
      FROM founder_soft_scores
      WHERE deal_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) fss ON true
    JOIN LATERAL (
      SELECT education_tier, domain_work_experience, seniority_of_roles, previous_startup_experience
      FROM founder_hard_scores
      WHERE deal_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) fhs ON true
  `
}

function toNum(v) {
    if (v === null || v === undefined || v === '') return 0
    return clampScore(v)
}

async function run() {
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)

    const rows = await getAllDealsWithScores()
    console.log(`Found ${rows.length} deals with stored scores.\n`)

    let updated = 0
    let errors = 0

    for (const row of rows) {
        const dealId = row.deal_id

        const softScores = {
            resilience: toNum(row.resilience),
            ambition: toNum(row.ambition),
            self_awareness: toNum(row.self_awareness),
            domain_fit: toNum(row.domain_fit),
            storytelling: toNum(row.storytelling)
        }

        const hardScores = {
            education_tier: toNum(row.education_tier),
            domain_work_experience: toNum(row.domain_work_experience),
            seniority_of_roles: toNum(row.seniority_of_roles),
            previous_startup_experience: toNum(row.previous_startup_experience)
        }

        const softWeightedScore = computeWeightedScore(softScores, SOFT_WEIGHTS)
        const hardWeightedScore = computeWeightedScore(hardScores, HARD_WEIGHTS)
        const finalScore = computeFinalScore(hardWeightedScore, softWeightedScore)
        const dd = getDDRecommendation(finalScore)

        console.log(`Deal ${dealId}: soft=${softWeightedScore} hard=${hardWeightedScore} final=${finalScore} → ${dd.recommendation}`)

        if (!DRY_RUN) {
            try {
                // Update the weighted scores on the existing soft/hard rows
                await sql`
          UPDATE founder_soft_scores
          SET soft_weighted_score = ${softWeightedScore}
          WHERE deal_id = ${dealId}
            AND created_at = (
              SELECT MAX(created_at) FROM founder_soft_scores WHERE deal_id = ${dealId}
            )
        `

                await sql`
          UPDATE founder_hard_scores
          SET hard_weighted_score = ${hardWeightedScore}
          WHERE deal_id = ${dealId}
            AND created_at = (
              SELECT MAX(created_at) FROM founder_hard_scores WHERE deal_id = ${dealId}
            )
        `

                // Update the existing final score row (not insert a new one)
                await sql`
          UPDATE founder_final_scores
          SET
            hard_weighted_score = ${hardWeightedScore},
            soft_weighted_score = ${softWeightedScore},
            final_score         = ${finalScore},
            dd_recommendation   = ${dd.recommendation},
            scored_at           = now()
          WHERE deal_id = ${dealId}
            AND scored_at = (
              SELECT MAX(scored_at) FROM founder_final_scores WHERE deal_id = ${dealId}
            )
        `

                await sql`
          UPDATE deals
          SET
            founder_soft_score  = ${softWeightedScore},
            founder_hard_score  = ${hardWeightedScore},
            founder_final_score = ${finalScore},
            dd_recommendation   = ${dd.recommendation},
            updated_at          = now()
          WHERE id = ${dealId}
        `

                updated += 1
            } catch (err) {
                console.error(`  ✗ Error on deal ${dealId}:`, err.message)
                errors += 1
            }
        } else {
            updated += 1
        }
    }

    console.log(`\nDone. Updated: ${updated} | Errors: ${errors}`)
}

run().catch((err) => {
    console.error('recomputeFounderScores failed:', err)
    process.exit(1)
})
