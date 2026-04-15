import { sql } from '../db/neon.js'
import { normalizeCompanyName } from './companyIdentity.js'

const NOISE_TOKENS = new Set([
  'ai',
  'inc',
  'incorporated',
  'ltd',
  'llc',
  'corp',
  'co',
  'company',
  'gmbh',
  'technologies',
  'technology',
  'tech',
  'labs',
  'lab'
])

function normalizeForSimilarity(value) {
  const normalized = normalizeCompanyName(value)
  if (!normalized) return ''
  const tokens = normalized
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !NOISE_TOKENS.has(token))
  return tokens.join(' ').trim()
}

function isPlausibleNameMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  return a.includes(b) || b.includes(a)
}

async function findDealsByDomain(companyDomain) {
  if (!companyDomain) return []
  const rows = await sql`
    SELECT id, company, company_domain, updated_at, created_at
    FROM deals
    WHERE company_domain = ${companyDomain}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  `
  return rows
}

async function findPlausibleDealsByName(extractedCompany) {
  const normalized = normalizeCompanyName(extractedCompany)
  if (!normalized) return []
  const broadRows = await sql`
    SELECT id, company, company_domain, updated_at, created_at
    FROM deals
    WHERE LOWER(company) LIKE ${`%${normalized}%`}
       OR ${normalized} LIKE '%' || LOWER(company) || '%'
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 15
  `
  const normalizedNeedle = normalizeForSimilarity(extractedCompany)
  return broadRows.filter((row) => {
    const normalizedRow = normalizeForSimilarity(row.company)
    return isPlausibleNameMatch(normalizedNeedle, normalizedRow)
  })
}

export async function evaluateDealIdentity({
  extractedCompany,
  companyDomain,
  companyMissing
}) {
  const domainMatches = await findDealsByDomain(companyDomain)
  if (domainMatches.length === 1) {
    return {
      decision: 'resolved',
      resolvedDealId: domainMatches[0].id,
      candidateDeals: domainMatches,
      reason: 'exact_domain_match'
    }
  }
  if (domainMatches.length > 1) {
    return {
      decision: 'ambiguous',
      resolvedDealId: null,
      candidateDeals: domainMatches,
      reason: 'multiple_domain_matches'
    }
  }

  if (companyMissing) {
    return {
      decision: 'create',
      resolvedDealId: null,
      candidateDeals: [],
      reason: 'company_missing'
    }
  }

  const nameCandidates = await findPlausibleDealsByName(extractedCompany)
  if (nameCandidates.length > 1) {
    return {
      decision: 'ambiguous',
      resolvedDealId: null,
      candidateDeals: nameCandidates,
      reason: 'multiple_name_candidates'
    }
  }

  return {
    decision: 'create',
    resolvedDealId: null,
    candidateDeals: [],
    reason: 'no_confident_match'
  }
}

export async function createDealIdentityAmbiguity({
  sourceType,
  sourceFileId,
  sourceFileName,
  extractedCompany,
  normalizedCompany,
  extractedDomain,
  candidateDealIds,
  pendingDealId,
  payload
}) {
  const rows = await sql`
    INSERT INTO deal_identity_ambiguities (
      source_type,
      source_file_id,
      source_file_name,
      extracted_company,
      normalized_company,
      extracted_domain,
      candidate_deal_ids,
      pending_deal_id,
      status,
      payload
    )
    VALUES (
      ${sourceType},
      ${sourceFileId ?? null},
      ${sourceFileName ?? null},
      ${extractedCompany ?? null},
      ${normalizedCompany ?? null},
      ${extractedDomain ?? null},
      ${JSON.stringify(candidateDealIds ?? [])}::jsonb,
      ${pendingDealId ?? null},
      ${'pending'},
      ${JSON.stringify(payload ?? {})}::jsonb
    )
    RETURNING *
  `
  return rows[0]
}
