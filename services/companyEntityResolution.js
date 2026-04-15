import { sql } from '../db/neon.js'
import { callWithTools } from './llm.js'

function stripLegalSuffixes(name) {
  if (!name) return ''
  const suffixes = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|technologies|tech|labs|lab)\.?$/i
  let cleaned = name.trim()
  while (true) {
    const next = cleaned.replace(suffixes, '').trim()
    if (next === cleaned) break
    cleaned = next
  }
  return cleaned.replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase()
}

async function searchCompanies({ query }) {
  const normQuery = query.toLowerCase().trim()
  if (!normQuery) return []
  const rows = await sql`
    SELECT id, name, canonical_name, aliases, source
    FROM companies
    WHERE LOWER(name) LIKE ${`%${normQuery}%`}
       OR LOWER(canonical_name) LIKE ${`%${normQuery}%`}
    LIMIT 5
  `
  return rows
}

async function getUnknownCompanyCount() {
  const rows = await sql`
    SELECT count(*) as cnt FROM companies 
    WHERE name ILIKE 'Unknown Company%'
  `
  return rows[0].cnt
}

export async function resolveCompanyEntity(extractionCompany, extractionFounder) {
  const rawName = extractionCompany || ''
  const normalizedName = stripLegalSuffixes(rawName)

  const tools = [
    {
      id: 'search_companies',
      description: 'Fuzzy search existing companies by name or canonical name to see if the deal belongs to an existing company.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search term to look for in the database. Strip legal suffixes for better matching.'
          }
        },
        required: ['query']
      }
    },
    {
      id: 'get_unknown_company_count',
      description: 'Returns the current count of unknown companies. Use this to construct a new unknown company name if fallback is required.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      id: 'finalize_resolution',
      description: 'Call this tool when you have decided how to resolve the entity.',
      inputSchema: {
        type: 'object',
        properties: {
          canonical_name: { type: 'string', description: 'The official clean name of the company. Omit legal suffixes if possible.' },
          company_id: { type: 'number', description: 'Existing company ID if matched, or -1 if new company.' },
          is_new: { type: 'boolean', description: 'True if no existing match was found and a new company should be created.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in this resolution. Low/medium leads to manual review.' },
          flagged_for_review: { type: 'boolean', description: 'Flag for review if you are not sure or if its a low/medium confidence match.' },
          fallback_used: { type: 'string', enum: ['none', 'stealth', 'unknown'], description: 'Was a fallback used because company name was missing?' },
          reason: { type: 'string', description: 'Explain why you made this decision.' }
        },
        required: ['canonical_name', 'company_id', 'is_new', 'confidence', 'flagged_for_review', 'fallback_used', 'reason']
      }
    }
  ]

  let messages = [
    {
      role: 'system',
      content: `You are a data validation agent responsible for mapping raw deal inputs to canonical company records in our database.
Your tasks:
1. You are given a raw company name extracted from a transcript, and a founder name (if available).
2. If the company name is valid/present, use 'search_companies' to find an existing match.
   - If a strong match is found, link it (is_new=false, confidence=high).
   - If weak matches, but you suspect it's the same, link it but with confidence=medium, flagged=true.
   - If no match, create new (is_new=true, confidence=high).
3. If company name is missing, generic (e.g. "unknown company"), or just placeholders:
   - Use fallback logic: fallback_used="stealth" if founder name is present. Format: "{founder_name}_stealth".
   - If neither available: fallback_used="unknown". Call 'get_unknown_company_count' and formulate name: "unknown_company_{N+1}".
4. You MUST call 'finalize_resolution' as your terminal action with the finalized payload.`
    },
    {
      role: 'user',
      content: `Extracted raw company name: "${rawName}"
Founder Name: "${extractionFounder || 'N/A'}"
Normalized Name (for reference): "${normalizedName}"`
    }
  ]

  let isDone = false
  let result = null

  // Agent Loop
  for (let step = 0; step < 8; step++) {
    const msg = await callWithTools(messages, tools)
    if (!msg) throw new Error('Agent returned empty.')
    messages.push(msg)

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments)
        let toolResult = ''

        if (call.function.name === 'search_companies') {
          const res = await searchCompanies(args)
          toolResult = JSON.stringify(res)
        } else if (call.function.name === 'get_unknown_company_count') {
          const res = await getUnknownCompanyCount()
          toolResult = JSON.stringify({ count: res })
        } else if (call.function.name === 'finalize_resolution') {
          result = args
          isDone = true
          toolResult = 'OK'
        } else {
          toolResult = 'Unknown tool.'
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult
        })
      }
    }

    if (isDone) break
  }

  if (!result) {
    result = {
      canonical_name: rawName || 'Unknown',
      company_id: -1,
      is_new: true,
      confidence: 'low',
      flagged_for_review: true,
      fallback_used: 'none',
      reason: 'Agent failed to converge. Defaulting to new review-flagged company.'
    }
  }

  return {
    ...result,
    extracted_raw_name: rawName,
    normalized_name: normalizedName
  }
}
