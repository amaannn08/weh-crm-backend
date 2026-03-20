import 'dotenv/config'

function getWehDomains() {
  const raw = process.env.WEH_DOMAINS
  const list = (raw ? raw.split(',') : ['wehventures.com'])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return new Set(list)
}

const DEFAULT_EMAIL_REGEX =
  /\b[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi

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

