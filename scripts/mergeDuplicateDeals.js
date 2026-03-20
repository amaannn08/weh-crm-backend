import 'dotenv/config'
import { sql } from '../db/neon.js'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required')
const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.DEAL_EXTRACTION_MODEL || 'deepseek-chat'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalize(name) {
    return (name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/(inc|ltd|llc|ai|labs|technologies|tech|solutions|platform|io)$/, '')
        .trim()
}

function avg(...nums) {
    const valid = nums.map(Number).filter(n => !isNaN(n) && n != null)
    if (!valid.length) return null
    return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10
}

async function llmMerge(fieldName, companyName, val1, val2) {
    const response = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a venture analyst assistant. Merge two pieces of deal notes into one concise, ' +
                        'non-redundant paragraph that preserves all unique insights. Return only the merged text, no preamble.'
                },
                {
                    role: 'user',
                    content:
                        `Company: ${companyName}\nField: ${fieldName}\n\nVersion A:\n${val1}\n\nVersion B:\n${val2}\n\nMerged:`
                }
            ],
            stream: false,
            max_tokens: 300
        })
    })
    if (!response.ok) throw new Error(`DeepSeek ${response.status}`)
    const json = await response.json()
    return json?.choices?.[0]?.message?.content?.trim() ?? val1
}

// ---------------------------------------------------------------------------
// Merge text: meeting/CSV value wins; if both exist and differ → LLM
// ---------------------------------------------------------------------------
async function mergeTextField(fieldName, companyName, csvVal, docxVal) {
    const a = (csvVal || '').trim()   // CSV/meeting value — most recent, wins
    const b = (docxVal || '').trim()  // docx-extracted value

    if (!a && !b) return null
    if (!a) return b
    if (!b) return a
    if (a.toLowerCase() === b.toLowerCase()) return a

    // Both exist and differ — ask LLM to merge
    console.log(`    ↪ LLM merging field "${fieldName}"...`)
    try {
        return await llmMerge(fieldName, companyName, a, b)
    } catch (err) {
        console.warn(`    ✗ LLM merge failed for "${fieldName}": ${err.message} — using CSV value`)
        return a // CSV value wins on failure
    }
}

// ---------------------------------------------------------------------------
// Find duplicate groups
// ---------------------------------------------------------------------------
async function findDuplicates() {
    const deals = await sql`
    SELECT id, company, source_file_name, created_at,
           poc, sector, status,
           exciting_reason, risks, pass_reasons, watch_reasons, action_required,
           conviction_score, founder_soft_score, founder_hard_score,
           founder_final_score, dd_recommendation
    FROM deals
    ORDER BY created_at ASC
  `
    const groups = new Map()
    for (const deal of deals) {
        const key = normalize(deal.company)
        if (!key) continue
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(deal)
    }
    return [...groups.values()].filter(g => g.length > 1)
}

// ---------------------------------------------------------------------------
// Reassign all child rows from dropId → keepId
// ---------------------------------------------------------------------------
async function reassignChildren(keepId, dropId) {
    await sql`UPDATE deal_meetings        SET deal_id = ${keepId} WHERE deal_id = ${dropId}`
    await sql`UPDATE founder_soft_scores  SET deal_id = ${keepId} WHERE deal_id = ${dropId}`
    await sql`UPDATE founder_hard_scores  SET deal_id = ${keepId} WHERE deal_id = ${dropId}`
    await sql`UPDATE founder_final_scores SET deal_id = ${keepId} WHERE deal_id = ${dropId}`
    await sql`UPDATE deal_insights        SET deal_id = ${keepId} WHERE deal_id = ${dropId}`
    await sql`UPDATE deal_files           SET deal_id = ${keepId} WHERE deal_id = ${dropId}`
    await sql`UPDATE meetings             SET drive_file_id = ${keepId} WHERE drive_file_id = ${dropId}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
    const groups = await findDuplicates()

    if (groups.length === 0) {
        console.log('No duplicate company names found. Nothing to merge.')
        process.exit(0)
    }

    console.log(`Found ${groups.length} group(s) with duplicate company names.\n`)

    let merged = 0
    let errors = 0

    for (const group of groups) {
        // Primary = docx-ingested (has source_file_name), fallback = oldest
        const primary = group.find(d => d.source_file_name) ?? group[0]
        const others = group.filter(d => d.id !== primary.id)

        // CSV-sourced deal = one WITHOUT source_file_name (created from the CSV import)
        const csvDeal = group.find(d => !d.source_file_name) ?? null

        console.log(`\n[GROUP] "${primary.company}" — merging ${others.length} duplicate(s) into ${primary.id}`)
        others.forEach(d => console.log(`  drop: "${d.company}" (${d.id}) source=${d.source_file_name ?? 'CSV'}`))

        try {
            // 1. Reassign child rows from all duplicates to primary
            for (const other of others) {
                await reassignChildren(primary.id, other.id)
            }

            // 2. Build merged scalar values
            // - Numeric scores: average across all non-null values
            const allScores = group.map(d => d.conviction_score).filter(v => v != null)
            const allSoftScores = group.map(d => d.founder_soft_score).filter(v => v != null)
            const allHardScores = group.map(d => d.founder_hard_score).filter(v => v != null)
            const allFinalScores = group.map(d => d.founder_final_score).filter(v => v != null)

            const mergedConviction = avg(...allScores)
            const mergedSoftScore = avg(...allSoftScores)
            const mergedHardScore = avg(...allHardScores)
            const mergedFinalScore = avg(...allFinalScores)

            // - Text fields: CSV value wins; if both differ → LLM
            const csvSrc = csvDeal ?? primary
            const docxSrc = csvDeal ? primary : null

            const companyName = primary.company

            const mergedPoc = csvSrc.poc || primary.poc || null
            const mergedSector = csvSrc.sector || primary.sector || null
            const mergedStatus = csvSrc.status || primary.status || null

            const mergedExciting = await mergeTextField(
                'why_exciting', companyName,
                csvSrc.exciting_reason, docxSrc?.exciting_reason
            )
            const mergedRisks = await mergeTextField(
                'risks', companyName,
                csvSrc.risks, docxSrc?.risks
            )
            const mergedPass = await mergeTextField(
                'pass_reasons', companyName,
                csvSrc.pass_reasons, docxSrc?.pass_reasons
            )
            const mergedWatch = await mergeTextField(
                'watch_reasons', companyName,
                csvSrc.watch_reasons, docxSrc?.watch_reasons
            )
            const mergedAction = await mergeTextField(
                'action_required', companyName,
                csvSrc.action_required, docxSrc?.action_required
            )

            // 3. Update the primary deal with merged values
            await sql`
        UPDATE deals SET
          poc               = ${mergedPoc},
          sector            = ${mergedSector},
          status            = ${mergedStatus},
          exciting_reason   = ${mergedExciting},
          risks             = ${mergedRisks},
          pass_reasons      = ${mergedPass},
          watch_reasons     = ${mergedWatch},
          action_required   = ${mergedAction},
          conviction_score  = ${mergedConviction},
          founder_soft_score  = ${mergedSoftScore},
          founder_hard_score  = ${mergedHardScore},
          founder_final_score = ${mergedFinalScore},
          updated_at = now()
        WHERE id = ${primary.id}
      `

            // 4. Delete duplicates
            for (const other of others) {
                await sql`DELETE FROM deals WHERE id = ${other.id}`
            }

            console.log(`  ✓ Merged successfully.`)
            merged += others.length
        } catch (err) {
            console.error(`  ✗ Failed: ${err.message}`)
            errors++
        }
    }

    console.log(`\nDone. Deals removed: ${merged}, Errors: ${errors}`)
    process.exit(0)
}

run().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
