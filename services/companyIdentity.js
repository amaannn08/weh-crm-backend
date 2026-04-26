import 'dotenv/config'
import { sql } from '../db/neon.js'

function getWehDomains() {
  const raw = process.env.WEH_DOMAINS
  const list = (raw ? raw.split(',') : ['wehventures.com'])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return new Set(list)
}

const DEFAULT_EMAIL_REGEX =
  /\b[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi

const PLAIN_GMAIL_DOMAIN = 'gmail.com'

function cleanDomain(domain) {
  if (!domain || typeof domain !== 'string') return null
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^[^@]*@/, '')
    .replace(/[)\].,;:'"!?]+$/g, '')
  if (!cleaned || !cleaned.includes('.')) return null
  return cleaned
}

export function extractCandidateDomainsFromTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') return []
  const found = new Set()
  for (const match of transcript.matchAll(DEFAULT_EMAIL_REGEX)) {
    const domain = cleanDomain(match?.[1])
    if (domain) found.add(domain)
  }
  return [...found]
}

export function pickBestNonWehDomainFromTranscript(transcript) {
  const wehDomains = getWehDomains()
  const candidates = extractCandidateDomainsFromTranscript(transcript)
  const nonWeh = candidates.filter((d) => !wehDomains.has(d))
  return nonWeh[0] ?? null
}

export function isPlainGmailDomain(domain) {
  return cleanDomain(domain) === PLAIN_GMAIL_DOMAIN
}

function labelizeDomainPart(part) {
  if (!part) return null
  const normalized = part
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  return normalized
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function deriveCompanyNameFromDomain(domain) {
  const cleaned = cleanDomain(domain)
  if (!cleaned) return null
  if (isPlainGmailDomain(cleaned)) return null
  const [root] = cleaned.split('.')
  return labelizeDomainPart(root)
}

export function isCompanyNameMissing(company) {
  if (!company || typeof company !== 'string') return true
  const c = company.trim().toLowerCase()
  return !c || c === 'unknown company' || c === 'unknown'
}

export function normalizeCompanyName(company) {
  if (!company || typeof company !== 'string') return null
  const trimmed = company.trim()
  if (!trimmed) return null
  return trimmed.toLowerCase()
}

function sanitizeFounderName(founderName) {
  if (!founderName || typeof founderName !== 'string') return null
  const cleaned = founderName
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
  if (!cleaned) return null
  return cleaned.replace(/\s+/g, '_')
}

async function getNextUnknownCompanyName() {
  const rows = await sql`SELECT nextval('unknown_company_seq') AS seq`
  const seq = rows[0]?.seq
  return `Unknown Company ${seq}`
}

export async function resolveCompanyNameFallback({ company, founderName }) {
  if (!isCompanyNameMissing(company)) return company.trim()

  const sanitizedFounderName = sanitizeFounderName(founderName)
  if (sanitizedFounderName) return `${sanitizedFounderName}_Stealth`

  return getNextUnknownCompanyName()
}

