class DealMergeError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'DealMergeError'
    this.status = status
  }
}

function toTimestamp(value) {
  if (!value) return -Infinity
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : -Infinity
}

function averageNullableNumbers(a, b) {
  const first = a == null ? null : Number(a)
  const second = b == null ? null : Number(b)
  const validFirst = Number.isFinite(first)
  const validSecond = Number.isFinite(second)
  if (validFirst && validSecond) return Math.round(((first + second) / 2) * 10) / 10
  if (validFirst) return first
  if (validSecond) return second
  return null
}

function mergeTextValues(primaryValue, secondaryValue) {
  const toParts = (value) =>
    String(value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)

  const parts = [...toParts(primaryValue), ...toParts(secondaryValue)]
  if (!parts.length) return null

  const seen = new Set()
  const unique = []
  for (const part of parts) {
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(part)
  }
  return unique.join(', ')
}

function normalizeStatus(status) {
  const value = String(status ?? '').trim()
  return value || null
}

function isNewStatus(status) {
  const normalized = normalizeStatus(status)
  if (!normalized) return true
  return normalized.toLowerCase() === 'new'
}

function pickMergedStatus(latestStatus, olderStatus) {
  const latest = normalizeStatus(latestStatus)
  const older = normalizeStatus(olderStatus)
  if (latest && !isNewStatus(latest)) return latest
  if (older && !isNewStatus(older)) return older
  return latest ?? older ?? null
}

export function pickPrimaryDeal(deals) {
  if (!Array.isArray(deals) || deals.length !== 2) {
    throw new DealMergeError('Exactly two deals are required for merge', 400)
  }
  const sorted = [...deals].sort((a, b) => {
    const updatedDiff = toTimestamp(b.updated_at) - toTimestamp(a.updated_at)
    if (updatedDiff !== 0) return updatedDiff
    const createdDiff = toTimestamp(b.created_at) - toTimestamp(a.created_at)
    if (createdDiff !== 0) return createdDiff
    return String(b.id).localeCompare(String(a.id))
  })
  return { primary: sorted[0], secondary: sorted[1] }
}

function sortDealsForMerge(deals) {
  return [...deals].sort((a, b) => {
    const updatedDiff = toTimestamp(b.updated_at) - toTimestamp(a.updated_at)
    if (updatedDiff !== 0) return updatedDiff
    const createdDiff = toTimestamp(b.created_at) - toTimestamp(a.created_at)
    if (createdDiff !== 0) return createdDiff
    return String(b.id).localeCompare(String(a.id))
  })
}

export function mergeMeetingFields(primaryMeeting, secondaryMeeting) {
  if (!secondaryMeeting) return null
  if (!primaryMeeting) {
    return {
      company: secondaryMeeting.company ?? null,
      meeting_date: secondaryMeeting.meeting_date ?? null,
      poc: secondaryMeeting.poc ?? null,
      sector: secondaryMeeting.sector ?? null,
      status: secondaryMeeting.status ?? null,
      exciting_reason: secondaryMeeting.exciting_reason ?? null,
      risks: secondaryMeeting.risks ?? null,
      conviction_score: secondaryMeeting.conviction_score ?? null,
      pass_reasons: secondaryMeeting.pass_reasons ?? null,
      watch_reasons: secondaryMeeting.watch_reasons ?? null,
      action_required: secondaryMeeting.action_required ?? null
    }
  }
  return {
    company: primaryMeeting.company ?? secondaryMeeting.company ?? null,
    meeting_date: primaryMeeting.meeting_date ?? secondaryMeeting.meeting_date ?? null,
    poc: mergeTextValues(primaryMeeting.poc, secondaryMeeting.poc),
    sector: primaryMeeting.sector ?? secondaryMeeting.sector ?? null,
    status: pickMergedStatus(primaryMeeting.status, secondaryMeeting.status),
    exciting_reason: primaryMeeting.exciting_reason ?? secondaryMeeting.exciting_reason ?? null,
    risks: primaryMeeting.risks ?? secondaryMeeting.risks ?? null,
    conviction_score: averageNullableNumbers(
      primaryMeeting.conviction_score,
      secondaryMeeting.conviction_score
    ),
    pass_reasons: primaryMeeting.pass_reasons ?? secondaryMeeting.pass_reasons ?? null,
    watch_reasons: primaryMeeting.watch_reasons ?? secondaryMeeting.watch_reasons ?? null,
    action_required: primaryMeeting.action_required ?? secondaryMeeting.action_required ?? null
  }
}

function mergeDealRowFields(primary, secondary) {
  return {
    company: primary.company ?? secondary.company ?? null,
    company_domain: primary.company_domain ?? secondary.company_domain ?? null,
    date: primary.date ?? secondary.date ?? null,
    poc: mergeTextValues(primary.poc, secondary.poc),
    sector: primary.sector ?? secondary.sector ?? null,
    founder_name: primary.founder_name ?? secondary.founder_name ?? null,
    meeting_date: primary.meeting_date ?? secondary.meeting_date ?? null,
    business_model: primary.business_model ?? secondary.business_model ?? null,
    status: pickMergedStatus(primary.status, secondary.status),
    stage: primary.stage ?? secondary.stage ?? null,
    risk_level: primary.risk_level ?? secondary.risk_level ?? null,
    source_file_name: primary.source_file_name ?? secondary.source_file_name ?? null,
    exciting_reason: primary.exciting_reason ?? secondary.exciting_reason ?? null,
    risks: primary.risks ?? secondary.risks ?? null,
    conviction_score: averageNullableNumbers(primary.conviction_score, secondary.conviction_score),
    pass_reasons: primary.pass_reasons ?? secondary.pass_reasons ?? null,
    watch_reasons: primary.watch_reasons ?? secondary.watch_reasons ?? null,
    action_required: primary.action_required ?? secondary.action_required ?? null,
    founder_score: averageNullableNumbers(primary.founder_score, secondary.founder_score),
    founder_soft_score: averageNullableNumbers(primary.founder_soft_score, secondary.founder_soft_score),
    founder_hard_score: averageNullableNumbers(primary.founder_hard_score, secondary.founder_hard_score),
    founder_final_score: averageNullableNumbers(primary.founder_final_score, secondary.founder_final_score),
    dd_recommendation: primary.dd_recommendation ?? secondary.dd_recommendation ?? null
  }
}

async function moveDealChildren(client, primaryId, secondaryId) {
  const tables = [
    'deal_insights',
    'deal_files',
    'founder_scores',
    'founder_signals',
    'founder_soft_scores',
    'founder_hard_scores',
    'founder_final_scores'
  ]

  const moved = {}
  // eslint-disable-next-line no-restricted-syntax
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop
    const result = await client.query(
      `UPDATE ${table} SET deal_id = $1 WHERE deal_id = $2`,
      [primaryId, secondaryId]
    )
    moved[table] = result.rowCount ?? 0
  }

  return moved
}

async function mergeDealMeetings(client, primaryDeal, secondaryDeal) {
  const result = await client.query(
    `SELECT * FROM deal_meetings WHERE deal_id = ANY($1::uuid[])`,
    [[primaryDeal.id, secondaryDeal.id]]
  )
  const primaryMeeting = result.rows.find((row) => row.deal_id === primaryDeal.id) ?? null
  const secondaryMeeting = result.rows.find((row) => row.deal_id === secondaryDeal.id) ?? null

  if (!secondaryMeeting) return { moved: 0, conflictResolved: false }

  if (!primaryMeeting) {
    await client.query(
      `UPDATE deal_meetings
       SET deal_id = $1, company = $2, updated_at = now()
       WHERE id = $3`,
      [primaryDeal.id, primaryDeal.company, secondaryMeeting.id]
    )
    return { moved: 1, conflictResolved: false }
  }

  const mergedMeeting = mergeMeetingFields(primaryMeeting, secondaryMeeting)
  await client.query(
    `UPDATE deal_meetings
     SET
      company = $1,
      meeting_date = $2,
      poc = $3,
      sector = $4,
      status = $5,
      exciting_reason = $6,
      risks = $7,
      conviction_score = $8,
      pass_reasons = $9,
      watch_reasons = $10,
      action_required = $11,
      updated_at = now()
     WHERE id = $12`,
    [
      primaryDeal.company,
      mergedMeeting.meeting_date,
      mergedMeeting.poc,
      mergedMeeting.sector,
      mergedMeeting.status,
      mergedMeeting.exciting_reason,
      mergedMeeting.risks,
      mergedMeeting.conviction_score,
      mergedMeeting.pass_reasons,
      mergedMeeting.watch_reasons,
      mergedMeeting.action_required,
      primaryMeeting.id
    ]
  )
  await client.query(`DELETE FROM deal_meetings WHERE id = $1`, [secondaryMeeting.id])
  return { moved: 0, conflictResolved: true }
}

function pickPrimaryWithPreference(deals, preferredPrimaryId) {
  const sortedDeals = sortDealsForMerge(deals)
  const selected = sortedDeals.find((deal) => deal.id === preferredPrimaryId)
  const primary = selected ?? sortedDeals[0]
  const secondaryDeals = sortedDeals.filter((deal) => deal.id !== primary.id)
  return { primary, secondaryDeals }
}

async function updateMergedPrimaryDeal(client, primaryId, mergedDeal) {
  await client.query(
    `UPDATE deals
     SET
       company = $1,
       company_domain = $2,
       date = $3,
       poc = $4,
       sector = $5,
       founder_name = $6,
       meeting_date = $7,
       business_model = $8,
       status = $9,
       stage = $10,
       risk_level = $11,
       source_file_name = $12,
       exciting_reason = $13,
       risks = $14,
       conviction_score = $15,
       pass_reasons = $16,
       watch_reasons = $17,
       action_required = $18,
       founder_score = $19,
       founder_soft_score = $20,
       founder_hard_score = $21,
       founder_final_score = $22,
       dd_recommendation = $23,
       updated_at = now()
     WHERE id = $24`,
    [
      mergedDeal.company,
      mergedDeal.company_domain,
      mergedDeal.date,
      mergedDeal.poc,
      mergedDeal.sector,
      mergedDeal.founder_name,
      mergedDeal.meeting_date,
      mergedDeal.business_model,
      mergedDeal.status,
      mergedDeal.stage,
      mergedDeal.risk_level,
      mergedDeal.source_file_name,
      mergedDeal.exciting_reason,
      mergedDeal.risks,
      mergedDeal.conviction_score,
      mergedDeal.pass_reasons,
      mergedDeal.watch_reasons,
      mergedDeal.action_required,
      mergedDeal.founder_score,
      mergedDeal.founder_soft_score,
      mergedDeal.founder_hard_score,
      mergedDeal.founder_final_score,
      mergedDeal.dd_recommendation,
      primaryId
    ]
  )
}

export async function mergeDealsTransactional(pool, dealIds, options = {}) {
  const { preferredPrimaryId = null } = options
  if (!Array.isArray(dealIds) || dealIds.length < 2) {
    throw new DealMergeError('At least two dealIds are required', 400)
  }
  const uniqueDealIds = [...new Set(dealIds)]
  if (uniqueDealIds.length < 2) {
    throw new DealMergeError('Cannot merge the same deal into itself', 400)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockedDeals = await client.query(
      `SELECT * FROM deals
       WHERE id = ANY($1::uuid[])
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
       FOR UPDATE`,
      [uniqueDealIds]
    )
    if (lockedDeals.rows.length !== uniqueDealIds.length) {
      throw new DealMergeError('One or more deals were not found', 404)
    }

    const { primary, secondaryDeals } = pickPrimaryWithPreference(lockedDeals.rows, preferredPrimaryId)
    let currentPrimary = { ...primary }
    const moved = {
      deal_insights: 0,
      deal_files: 0,
      founder_scores: 0,
      founder_signals: 0,
      founder_soft_scores: 0,
      founder_hard_scores: 0,
      founder_final_scores: 0,
      deal_meetings: 0
    }
    const mergedDealIds = []
    const mergedCompanies = []
    let conflictResolved = false

    for (const secondary of secondaryDeals) {
      const mergedDeal = mergeDealRowFields(currentPrimary, secondary)
      const meetingsSummary = await mergeDealMeetings(client, currentPrimary, secondary)
      const movedPerSecondary = await moveDealChildren(client, currentPrimary.id, secondary.id)
      moved.deal_meetings += meetingsSummary.moved
      for (const [key, value] of Object.entries(movedPerSecondary)) {
        moved[key] += value
      }

      await updateMergedPrimaryDeal(client, currentPrimary.id, mergedDeal)
      await client.query(`DELETE FROM deals WHERE id = $1`, [secondary.id])

      mergedDealIds.push(secondary.id)
      mergedCompanies.push(secondary.company)
      conflictResolved = conflictResolved || meetingsSummary.conflictResolved
      currentPrimary = { ...currentPrimary, ...mergedDeal, id: currentPrimary.id }
    }

    await client.query('COMMIT')

    return {
      primaryDealId: currentPrimary.id,
      mergedDealId: mergedDealIds[0] ?? null,
      mergedDealIds,
      primaryCompany: currentPrimary.company,
      mergedCompany: mergedCompanies[0] ?? null,
      mergedCompanies,
      moved,
      conflictResolved
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export { DealMergeError }
