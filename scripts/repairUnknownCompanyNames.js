import 'dotenv/config'
import { sql } from '../db/neon.js'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required')

const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.DEAL_EXTRACTION_MODEL || 'deepseek-chat'

// ---------------------------------------------------------------------------
// Shared: call DeepSeek and return the reply string
// ---------------------------------------------------------------------------
async function askDeepSeek(systemInstruction, userPrompt, maxTokens = 30) {
    const response = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: userPrompt }
            ],
            stream: false,
            max_tokens: maxTokens
        })
    })

    if (!response.ok) {
        const txt = await response.text().catch(() => '')
        throw new Error(`DeepSeek ${response.status}: ${txt.slice(0, 120)}`)
    }

    const json = await response.json()
    const raw = json?.choices?.[0]?.message?.content?.trim()
    if (!raw || raw.length === 0) throw new Error('Empty response from LLM')
    return raw
}

// ---------------------------------------------------------------------------
// Strategy 1 — derive company name from domain
// ---------------------------------------------------------------------------
async function resolveCompanyNameFromDomain(domain) {
    // Quick local heuristic as a fallback
    const apex = domain.split('.').slice(0, -1).join(' ')
    const localGuess = apex
        .split(/[\s-_]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')

    try {
        const name = await askDeepSeek(
            'You are a company name resolver. Given a domain name, return ONLY the real-world company name (not the URL). If unsure, return the most likely brand name derived from the domain. No explanation, punctuation, or extra text — just the company name.',
            `Domain: ${domain}\nCompany name:`
        )
        // Sanity check: reject if LLM returns something that looks like a URL or is too long
        if (name.length < 80 && !name.includes('/') && !name.includes('http')) {
            return name
        }
    } catch (err) {
        console.warn(`    LLM domain lookup failed: ${err.message} — using local guess "${localGuess}"`)
    }

    return localGuess
}

// ---------------------------------------------------------------------------
// Strategy 2 — retry company extraction from the original transcript + filename hint
// ---------------------------------------------------------------------------
async function resolveCompanyNameFromTranscript(transcript, fileName) {
    const MAX_CHARS = 6000
    const trimmed = transcript.length > MAX_CHARS
        ? `${transcript.slice(0, MAX_CHARS)}\n\n[TRUNCATED]`
        : transcript

    const fileHint = fileName
        ? `\n\nNote: the source filename is "${fileName}" — this may help identify the company.`
        : ''

    const name = await askDeepSeek(
        'You are a venture investor assistant. Extract ONLY the startup or company name from the meeting transcript below. ' +
        'Use any available clues — including the filename hint if provided — to make your best guess. ' +
        'Return just the company name, nothing else. Only return "Unknown" if there is truly no way to determine it.',
        `Transcript:\n"""\n${trimmed}\n"""${fileHint}\n\nCompany name:`,
        40
    )

    console.log(`    LLM raw response: "${name}"`)

    if (!name || name.toLowerCase() === 'unknown') return null
    return name
}

// ---------------------------------------------------------------------------
// Strategy 3 — ask the LLM to interpret the filename
// Most files follow: "CompanyName _ WEH Ventures - date.docx"
// The LLM is better than a regex at knowing what's a company vs a person name.
// ---------------------------------------------------------------------------
async function resolveCompanyNameFromFilename(fileName) {
    // Pre-clean: strip date/time suffix and extension for a cleaner input
    const cleaned = fileName
        .replace(/\s*-\s*20\d{2}_.*$/, '') // remove "- 2026_01_28 ..." onwards
        .replace(/\.docx$/i, '')
        .trim()

    try {
        const name = await askDeepSeek(
            'You are a company name extractor. Given a meeting filename (possibly cleaned), extract ONLY the startup or company name being discussed. ' +
            'Ignore investor firm names like "WEH Ventures", person names, generic terms like "Intro call", and dates. ' +
            'If the filename only contains person names with no obvious company, return "Unknown". ' +
            'Return just the company name, nothing else.',
            `Filename: "${cleaned}"\nCompany name:`,
            40
        )

        console.log(`    LLM filename response: "${name}"`)
        if (!name || name.toLowerCase() === 'unknown') return null
        return name
    } catch (err) {
        console.warn(`    LLM filename lookup failed: ${err.message}`)
        return null
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
    const rows = await sql`
    SELECT d.id, d.company, d.company_domain, d.source_file_name
    FROM deals d
    WHERE LOWER(TRIM(d.company)) IN ('unknown company', 'unknown', '')
       OR d.company IS NULL
    ORDER BY d.created_at ASC
  `

    if (rows.length === 0) {
        console.log('No deals with unknown company name found. Nothing to do.')
        process.exit(0)
    }

    console.log(`Found ${rows.length} deal(s) with unknown company name — resolving...\n`)

    let updated = 0
    let failed = 0

    for (const row of rows) {
        const hasDomain = row.company_domain && row.company_domain.trim() !== ''
        console.log(`[${row.id}] file="${row.source_file_name}" domain="${row.company_domain ?? 'none'}"`)

        let companyName = null

        // Strategy 1: resolve from domain
        if (hasDomain) {
            console.log(`    Strategy 1: domain → "${row.company_domain}"`)
            try {
                companyName = await resolveCompanyNameFromDomain(row.company_domain.trim())
            } catch (err) {
                console.warn(`    ✗ Domain strategy failed: ${err.message}`)
            }
        }

        // Strategy 2: re-extract from transcript
        if (!companyName) {
            console.log(`    Strategy 2: transcript re-extraction`)
            try {
                // Fetch the matching transcript from meetings table
                const meetingRows = await sql`
          SELECT transcript
          FROM meetings
          WHERE source_file_name = ${row.source_file_name}
          LIMIT 1
        `
                if (meetingRows[0]?.transcript) {
                    companyName = await resolveCompanyNameFromTranscript(meetingRows[0].transcript, row.source_file_name)
                } else {
                    console.warn(`    ✗ No transcript found for source_file_name="${row.source_file_name}"`)
                }
            } catch (err) {
                console.warn(`    ✗ Transcript strategy failed: ${err.message}`)
            }
        }

        // Strategy 3: parse from filename
        if (!companyName && row.source_file_name) {
            console.log(`    Strategy 3: filename parse`)
            try {
                companyName = await resolveCompanyNameFromFilename(row.source_file_name)
                if (companyName) console.log(`    LLM filename response: "${companyName}"`)
            } catch (err) {
                console.warn(`    ✗ Filename strategy failed: ${err.message}`)
            }
        }

        if (!companyName) {
            console.warn(`    ✗ Could not resolve company name — skipping.\n`)
            failed++
            continue
        }

        console.log(`    → resolved to: "${companyName}"`)

        try {
            await sql`
        UPDATE deals
        SET company = ${companyName}, updated_at = now()
        WHERE id = ${row.id}
      `
            console.log(`    ✓ Updated.\n`)
            updated++
        } catch (err) {
            console.error(`    ✗ DB update failed: ${err.message}\n`)
            failed++
        }
    }

    console.log(`Done. Updated: ${updated}, Failed/skipped: ${failed}, Total: ${rows.length}`)
    process.exit(0)
}

run().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
