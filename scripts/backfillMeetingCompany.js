/**
 * backfillMeetingCompany.js
 *
 * Populates the `company` column on the `meetings` table for existing rows.
 *
 * Strategy:
 *  1. JOIN with `deals` on source_file_name — fast, no LLM needed
 *  2. Fallback: ask DeepSeek to extract company from the transcript text
 *
 * Run: node backend/scripts/backfillMeetingCompany.js
 */
import 'dotenv/config'
import { sql } from '../db/neon.js'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required')
const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.DEAL_EXTRACTION_MODEL || 'deepseek-chat'

async function askLLM(transcript, fileName) {
    const MAX_CHARS = 5000
    const trimmed = transcript.length > MAX_CHARS
        ? `${transcript.slice(0, MAX_CHARS)}\n[TRUNCATED]`
        : transcript

    const fileHint = fileName ? `\nFilename hint: "${fileName}"` : ''

    const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
            model: MODEL,
            stream: false,
            max_tokens: 30,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a company name extractor. Given a meeting transcript and optional filename, ' +
                        'return ONLY the startup or company name being discussed. No explanation. ' +
                        'If truly unknown, return "Unknown".'
                },
                {
                    role: 'user',
                    content: `Transcript:\n"""\n${trimmed}\n"""${fileHint}\n\nCompany name:`
                }
            ]
        })
    })

    if (!res.ok) throw new Error(`DeepSeek ${res.status}`)
    const json = await res.json()
    const name = json?.choices?.[0]?.message?.content?.trim()
    if (!name || name.toLowerCase() === 'unknown') return null
    return name
}

async function run() {
    // Only process rows where company is null or empty
    const rows = await sql`
    SELECT id, source_file_name, transcript
    FROM meetings
    WHERE company IS NULL OR TRIM(company) = ''
    ORDER BY ingested_at ASC
  `

    if (rows.length === 0) {
        console.log('All meetings already have a company. Nothing to do.')
        process.exit(0)
    }

    console.log(`Found ${rows.length} meeting(s) without company.\n`)

    // Build a lookup: source_file_name → company from deals table
    const dealsRows = await sql`
    SELECT source_file_name, company
    FROM deals
    WHERE source_file_name IS NOT NULL AND TRIM(company) != '' AND LOWER(TRIM(company)) != 'unknown company'
  `
    const dealMap = new Map()
    for (const d of dealsRows) {
        if (d.source_file_name && d.company) {
            dealMap.set(d.source_file_name.trim(), d.company)
        }
    }

    let updated = 0, llmUsed = 0, failed = 0

    for (const row of rows) {
        const fileName = (row.source_file_name || '').trim()
        let company = dealMap.get(fileName) ?? null

        if (company) {
            console.log(`[JOIN]  "${fileName}" → "${company}"`)
        } else {
            console.log(`[LLM]   "${fileName}" — no deal match, asking LLM...`)
            try {
                company = await askLLM(row.transcript, fileName)
                if (company) {
                    console.log(`        → "${company}"`)
                    llmUsed++
                } else {
                    console.warn(`        → could not determine company, skipping.`)
                    failed++
                    continue
                }
            } catch (err) {
                console.warn(`        → LLM failed: ${err.message}`)
                failed++
                continue
            }
        }

        try {
            await sql`UPDATE meetings SET company = ${company} WHERE id = ${row.id}`
            updated++
        } catch (err) {
            console.error(`        → DB update failed: ${err.message}`)
            failed++
        }
    }

    console.log(`\nDone. Updated: ${updated} (LLM used for ${llmUsed}), Failed/skipped: ${failed}`)
    process.exit(0)
}

run().catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
})
