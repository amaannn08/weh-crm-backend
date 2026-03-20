import 'dotenv/config'
import { sql } from '../db/neon.js'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required')

const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.DEAL_EXTRACTION_MODEL || 'deepseek-chat'

// ---------------------------------------------------------------------------
// Ask DeepSeek a question, return the trimmed reply
// ---------------------------------------------------------------------------
async function askDeepSeek(systemInstruction, userPrompt, maxTokens = 40) {
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
// Extract POC from a transcript
// POC = the person from the fund (WEH Ventures) side who attended the meeting
// ---------------------------------------------------------------------------
async function extractPocFromTranscript(transcript, fileName) {
    const MAX_CHARS = 6000
    const trimmed = transcript.length > MAX_CHARS
        ? `${transcript.slice(0, MAX_CHARS)}\n\n[TRUNCATED]`
        : transcript

    const fileHint = fileName
        ? `\n\nNote: the source filename is "${fileName}" — this may help identify the WEH person.`
        : ''

    const poc = await askDeepSeek(
        'You are a venture investor assistant. ' +
        'Your job is to identify the POC — the person from the fund side (WEH Ventures) who attended the meeting. ' +
        'Common WEH team members are: Ritik Rustagi, Rohit Krishna, Deepak, and similar. ' +
        'Look for who the meeting is attributed to on the investor side, not the founder. ' +
        'Return ONLY the name, nothing else. If you cannot determine it, return "Unknown".',
        `Transcript:\n"""\n${trimmed}\n"""${fileHint}\n\nPOC (WEH team member):`,
        40
    )

    console.log(`    LLM raw response: "${poc}"`)

    if (!poc || poc.toLowerCase() === 'unknown') return null
    return poc
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
    const rows = await sql`
    SELECT d.id, d.company, d.poc, d.source_file_name
    FROM deals d
    WHERE d.poc IS NULL OR TRIM(d.poc) = ''
    ORDER BY d.created_at ASC
  `

    if (rows.length === 0) {
        console.log('No deals with blank POC found. Nothing to do.')
        process.exit(0)
    }

    console.log(`Found ${rows.length} deal(s) with blank POC — resolving...\n`)

    let updated = 0
    let failed = 0

    for (const row of rows) {
        console.log(`[${row.id}] company="${row.company}" file="${row.source_file_name}"`)

        // Fetch transcript from meetings table
        let transcript = null
        try {
            const meetingRows = await sql`
        SELECT transcript
        FROM meetings
        WHERE source_file_name = ${row.source_file_name}
        LIMIT 1
      `
            transcript = meetingRows[0]?.transcript ?? null
        } catch (err) {
            console.warn(`    ✗ Failed to fetch transcript: ${err.message}`)
        }

        // Also try matching by filename without leading space (some files have it)
        if (!transcript && row.source_file_name) {
            try {
                const meetingRows = await sql`
          SELECT transcript
          FROM meetings
          WHERE TRIM(source_file_name) = TRIM(${row.source_file_name})
          LIMIT 1
        `
                transcript = meetingRows[0]?.transcript ?? null
            } catch (_) { }
        }

        if (!transcript) {
            console.warn(`    ✗ No transcript found — skipping.\n`)
            failed++
            continue
        }

        let poc = null
        try {
            poc = await extractPocFromTranscript(transcript, row.source_file_name)
        } catch (err) {
            console.warn(`    ✗ LLM failed: ${err.message}`)
        }

        // Fallback: parse POC from filename — files often contain the WEH person's name
        // e.g. "Aanya Jaiswal  and Ritik Rustagi - ..." → Ritik Rustagi
        if (!poc && row.source_file_name) {
            const fileNameClean = row.source_file_name.replace(/\s*-\s*20\d{2}_.*$/, '').replace(/\.docx$/i, '').trim()
            // Common WEH team members to scan for
            const wehMembers = ['Ritik Rustagi', 'Rohit Krishna', 'Deepak']
            for (const member of wehMembers) {
                if (fileNameClean.toLowerCase().includes(member.toLowerCase())) {
                    poc = member
                    console.log(`    Filename hint: "${poc}"`)
                    break
                }
            }
        }

        if (!poc) {
            console.warn(`    ✗ Could not determine POC — skipping.\n`)
            failed++
            continue
        }

        console.log(`    → resolved to: "${poc}"`)

        try {
            await sql`
        UPDATE deals
        SET poc = ${poc}, updated_at = now()
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
