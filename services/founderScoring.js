import { sql } from '../db/neon.js'
import { extractDealFromTranscript } from './dealExtraction.js'
import { normalizeCompanyName } from './companyIdentity.js'

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

export function clampScore(value) {
  const num = Number(value)
  if (Number.isNaN(num)) return 0
  if (num < 0) return 0
  if (num > 10) return 10
  return Math.round(num * 10) / 10
}

/**
 * Accepts a scores object and a weights object.
 * ALL dimensions are included — a score of 0 means the trait was absent/unmentioned
 * and should genuinely lower the final result rather than being silently skipped.
 */
export function computeWeightedScore(scores, weights) {
  const entries = Object.entries(weights).map(([key, weight]) => ({
    key,
    weight,
    value: clampScore(scores[key] ?? 0)
  }))

  if (!entries.length) return 0

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (totalWeight <= 0) return 0

  const score = entries.reduce((sum, entry) => {
    return sum + entry.value * (entry.weight / totalWeight)
  }, 0)

  return Math.round(score * 10) / 10
}

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SOFT WEIGHTS — behavioural signals from transcript / pitch
 * Source: image reference (Resilience 25, Ambition 20, Self-Awareness 20,
 *         Domain Fit 20, Storytelling 15)
 */
export const SOFT_WEIGHTS = {
  resilience: 0.25,
  ambition: 0.2,
  self_awareness: 0.2,
  domain_fit: 0.2,
  storytelling: 0.15
}

/**
 * HARD WEIGHTS — verifiable facts: education, work history, roles
 */
export const HARD_WEIGHTS = {
  education_tier: 0.2,
  domain_work_experience: 0.35,
  seniority_of_roles: 0.25,
  previous_startup_experience: 0.2
}

/**
 * FINAL WEIGHTS — how hard and soft combine into the gate score
 */
export const FINAL_WEIGHTS = {
  hard: 0.4,
  soft: 0.6
}

// ─────────────────────────────────────────────────────────────────────────────
// DUE DILIGENCE GATE
// ─────────────────────────────────────────────────────────────────────────────

export function getDDRecommendation(finalScore) {
  if (finalScore >= 8.0) {
    return {
      recommendation: 'GO',
      label: 'Proceed to full due diligence',
      reason:
        'Founder clears the bar on both verifiable credentials and behavioural signals.'
    }
  }
  if (finalScore >= 6.5) {
    return {
      recommendation: 'CONDITIONAL',
      label: 'One more call - probe identified gaps',
      reason:
        'Promising signals but specific gaps need validation before committing to DD.'
    }
  }
  return {
    recommendation: 'PASS',
    label: 'Archive with scoring rationale',
    reason:
      'Score does not meet threshold. Document gaps for future re-engagement if circumstances change.'
  }
}

export function computeFinalScore(hardWeightedScore, softWeightedScore) {
  const final =
    hardWeightedScore * FINAL_WEIGHTS.hard +
    softWeightedScore * FINAL_WEIGHTS.soft
  return Math.round(final * 10) / 10
}

export async function scoreFounderFromTranscript({ transcript, extraction }) {
  if (!extraction) {
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      throw new Error('Transcript is required for founder scoring')
    }

    const MAX_CHARS = 20000
    const trimmed =
      transcript.length > MAX_CHARS
        ? `${transcript.slice(0, MAX_CHARS)}\n\n[TRUNCATED FOR SCORING]`
        : transcript

    extraction = await extractDealFromTranscript({ transcript: trimmed })
  }

  const archetype = extraction.founder_archetype ?? {}

  const softScores = {
    resilience: clampScore(archetype.resilience),
    ambition: clampScore(archetype.ambition),
    self_awareness: clampScore(archetype.self_awareness),
    domain_fit: clampScore(archetype.domain_fit),
    storytelling: clampScore(archetype.storytelling)
  }

  const softWeightedScore = computeWeightedScore(softScores, SOFT_WEIGHTS)

  const qualitySignals = extraction.founder_quality_signals ?? {}

  const hardScores = {
    education_tier: clampScore(qualitySignals.education_tier),
    domain_work_experience: clampScore(qualitySignals.domain_work_experience),
    seniority_of_roles: clampScore(qualitySignals.seniority_of_roles),
    previous_startup_experience: clampScore(
      qualitySignals.previous_startup_experience
    )
  }

  const hardWeightedScore = computeWeightedScore(hardScores, HARD_WEIGHTS)

  const finalScore = computeFinalScore(hardWeightedScore, softWeightedScore)
  const ddRecommendation = getDDRecommendation(finalScore)

  return {
    softScores,
    softWeightedScore,
    archetype: archetype.label ?? null,
    evidence: archetype.evidence ?? {},
    hardScores,
    hardWeightedScore,
    finalScore,
    ddRecommendation: ddRecommendation.recommendation,
    ddLabel: ddRecommendation.label,
    ddReason: ddRecommendation.reason,
    raw: extraction
  }
}

/**
 * Call this separately when you have verified CV / LinkedIn data.
 * Input: plain object with the four hard dimensions already scored 0–10.
 */
export function computeHardScoreFromFacts(facts) {
  const hardScores = {
    education_tier: clampScore(facts.education_tier),
    domain_work_experience: clampScore(facts.domain_work_experience),
    seniority_of_roles: clampScore(facts.seniority_of_roles),
    previous_startup_experience: clampScore(
      facts.previous_startup_experience
    )
  }

  const hardWeightedScore = computeWeightedScore(hardScores, HARD_WEIGHTS)
  return { hardScores, hardWeightedScore }
}

export async function saveFounderScore({
  dealId,
  softScores,
  softWeightedScore,
  hardScores,
  hardWeightedScore,
  finalScore,
  ddRecommendation,
  archetype,
  evidence,
  rawPayload
}) {
  const dealCheck = await sql`
    SELECT id
    FROM deals
    WHERE id = ${dealId}
    LIMIT 1
  `

  if (!dealCheck[0]) throw new Error('Deal not found')

  const softRows = await sql`
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
      ${archetype},
      ${JSON.stringify({
    evidence,
    raw: rawPayload
  })}
    )
    RETURNING *
  `

  const hardRows = await sql`
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
    RETURNING *
  `

  const finalRows = await sql`
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
      ${ddRecommendation},
      now()
    )
    RETURNING *
  `

  const dealRows = await sql`
    UPDATE deals
    SET
      founder_soft_score = ${softWeightedScore},
      founder_hard_score = ${hardWeightedScore},
      founder_final_score = ${finalScore},
      dd_recommendation = ${ddRecommendation},
      conviction_score = COALESCE(conviction_score, ${finalScore}),
      updated_at = now()
    WHERE id = ${dealId}
    RETURNING *
  `

  return {
    deal: dealRows[0],
    softScore: softRows[0],
    hardScore: hardRows[0],
    finalScore: finalRows[0]
  }
}

export async function scoreAndSaveFounder({
  dealId,
  transcript,
  hardFacts,
  extraction
}) {
  const transcriptResult = await scoreFounderFromTranscript({
    transcript,
    extraction
  })

  let hardScores = transcriptResult.hardScores
  let hardWeightedScore = transcriptResult.hardWeightedScore

  if (hardFacts) {
    const verified = computeHardScoreFromFacts(hardFacts)
    hardScores = verified.hardScores
    hardWeightedScore = verified.hardWeightedScore
  }

  const finalScore = computeFinalScore(
    hardWeightedScore,
    transcriptResult.softWeightedScore
  )
  const ddResult = getDDRecommendation(finalScore)

  const saved = await saveFounderScore({
    dealId,
    softScores: transcriptResult.softScores,
    softWeightedScore: transcriptResult.softWeightedScore,
    hardScores,
    hardWeightedScore,
    finalScore,
    ddRecommendation: ddResult.recommendation,
    archetype: transcriptResult.archetype,
    evidence: transcriptResult.evidence,
    rawPayload: transcriptResult.raw
  })

  return {
    ...saved,
    softScores: transcriptResult.softScores,
    softWeightedScore: transcriptResult.softWeightedScore,
    hardScores,
    hardWeightedScore,
    finalScore,
    ddRecommendation: ddResult.recommendation,
    ddLabel: ddResult.label,
    ddReason: ddResult.reason,
    archetype: transcriptResult.archetype,
    evidence: transcriptResult.evidence
  }
}

function averageNumbers(values) {
  const nums = values
    .map((v) => (v === null || v === undefined ? null : Number(v)))
    .filter((v) => typeof v === 'number' && !Number.isNaN(v))
  if (!nums.length) return 0
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  return Math.round(avg * 10) / 10
}

async function getLatestSoftScores(dealId) {
  const rows = await sql`
    SELECT
      resilience,
      ambition,
      self_awareness,
      domain_fit,
      storytelling
    FROM founder_soft_scores
    WHERE deal_id = ${dealId}
    ORDER BY created_at DESC
    LIMIT 1
  `
  return rows[0] ?? null
}

async function getLatestHardScores(dealId) {
  const rows = await sql`
    SELECT
      education_tier,
      domain_work_experience,
      seniority_of_roles,
      previous_startup_experience
    FROM founder_hard_scores
    WHERE deal_id = ${dealId}
    ORDER BY created_at DESC
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Averages *dimensions* across all deals matching the same company identity
 * (normalized company name, or company_domain), then recomputes weighted/final/DD.
 *
 * Persists the merged scores as new rows for `dealId` (soft/hard/final) and updates
 * the `deals` row denormalized score columns.
 */
export async function mergeScoresForCompanyIdentity({
  dealId,
  companyName,
  companyDomain
}) {
  const dealIds = new Set([dealId])

  const normalizedName = normalizeCompanyName(companyName)
  if (normalizedName) {
    const rows = await sql`
      SELECT id
      FROM deals
      WHERE LOWER(TRIM(company)) = ${normalizedName}
    `
    for (const r of rows) if (r?.id) dealIds.add(r.id)
  }

  if (companyDomain) {
    const rows = await sql`
      SELECT id
      FROM deals
      WHERE company_domain = ${companyDomain}
    `
    for (const r of rows) if (r?.id) dealIds.add(r.id)
  }

  const ids = [...dealIds]

  const softByDeal = await Promise.all(ids.map((id) => getLatestSoftScores(id)))
  const hardByDeal = await Promise.all(ids.map((id) => getLatestHardScores(id)))

  const mergedSoft = {
    resilience: clampScore(averageNumbers(softByDeal.map((r) => r?.resilience))),
    ambition: clampScore(averageNumbers(softByDeal.map((r) => r?.ambition))),
    self_awareness: clampScore(
      averageNumbers(softByDeal.map((r) => r?.self_awareness))
    ),
    domain_fit: clampScore(averageNumbers(softByDeal.map((r) => r?.domain_fit))),
    storytelling: clampScore(
      averageNumbers(softByDeal.map((r) => r?.storytelling))
    )
  }

  const mergedHard = {
    education_tier: clampScore(
      averageNumbers(hardByDeal.map((r) => r?.education_tier))
    ),
    domain_work_experience: clampScore(
      averageNumbers(hardByDeal.map((r) => r?.domain_work_experience))
    ),
    seniority_of_roles: clampScore(
      averageNumbers(hardByDeal.map((r) => r?.seniority_of_roles))
    ),
    previous_startup_experience: clampScore(
      averageNumbers(hardByDeal.map((r) => r?.previous_startup_experience))
    )
  }

  const softWeightedScore = computeWeightedScore(mergedSoft, SOFT_WEIGHTS)
  const hardWeightedScore = computeWeightedScore(mergedHard, HARD_WEIGHTS)
  const finalScore = computeFinalScore(hardWeightedScore, softWeightedScore)
  const ddResult = getDDRecommendation(finalScore)

  return await saveFounderScore({
    dealId,
    softScores: mergedSoft,
    softWeightedScore,
    hardScores: mergedHard,
    hardWeightedScore,
    finalScore,
    ddRecommendation: ddResult.recommendation,
    archetype: null,
    evidence: {
      merged_from_deal_ids: ids,
      merge_method: 'dimension_average_latest_scores_per_deal'
    },
    rawPayload: {
      merged: true,
      merged_from_deal_ids: ids,
      company_name_normalized: normalizedName,
      company_domain: companyDomain
    }
  })
}
