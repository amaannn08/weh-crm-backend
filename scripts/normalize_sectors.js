#!/usr/bin/env node
/**
 * normalize_sectors.js
 *
 * One-time script to clean up freeform sector values in the deals table.
 * Maps each unique sector string → nearest canonical sector using DeepSeek.
 *
 * Usage:
 *   node scripts/normalize_sectors.js --dry-run   # preview changes, no DB writes
 *   node scripts/normalize_sectors.js             # apply changes to DB
 */

import 'dotenv/config'
import pg from 'pg'

// Use a dedicated client — avoids pg-pool idle timeout / AggregateError issues in scripts
let client

async function query(text, params) {
  if (!client) {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
  }
  return client.query(text, params)
}

async function closeDb() {
  if (client) await client.end().catch(() => {})
}


const CANONICAL_SECTORS = [
  'Fintech',
  'B2B SaaS',
  'Consumer Tech',
  'D2C / Consumer Brands',
  'Food & Beverage',
  'AgriTech',
  'HealthTech',
  'EdTech',
  'CleanTech / Sustainability',
  'AI / ML',
  'Gaming',
  'E-commerce',
  'Logistics / Supply Chain',
  'Robotics',
  'Cybersecurity',
  'Real Estate / PropTech',
  'Media / Content',
  'Social Commerce',
  'Other'
]

const DRY_RUN = process.argv.includes('--dry-run')

// ─── DeepSeek batch mapper ────────────────────────────────────────────────────

async function fetchWithRetry(url, options, maxAttempts = 5) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, options)
    } catch (err) {
      lastErr = err
      const code = err?.cause?.code || ''
      const msg  = err?.message || ''
      const isRetryable =
        code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
        msg === 'terminated'  || msg === 'fetch failed'
      if (!isRetryable || attempt === maxAttempts) throw err
      const delay = attempt * 3000   // 3s, 6s, 9s, 12s
      console.log(`  ⚠️  Network error (${code || msg}), retrying in ${delay / 1000}s (attempt ${attempt}/${maxAttempts})...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

async function mapSectorsToCanonical(rawSectors) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set')

  const prompt = `
You are normalizing startup sector labels for a VC CRM database.

Canonical sector list (you must pick EXACTLY one per input, or "Other"):
${CANONICAL_SECTORS.join(', ')}

Input sector strings to map (one per line):
${rawSectors.map((s, i) => `${i + 1}. "${s}"`).join('\n')}

Return a JSON array with exactly ${rawSectors.length} elements, each being the canonical sector string.
Example format: ["Fintech", "Food & Beverage", "B2B SaaS"]
Output ONLY the JSON array, no commentary.
`

  const response = await fetchWithRetry('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'You are a data normalization assistant. Output only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      stream: false
    })
  })

  if (!response.ok) {
    const txt = await response.text().catch(() => '')
    throw new Error(`DeepSeek API error ${response.status}: ${txt.slice(0, 200)}`)
  }

  const json = await response.json()
  const content = json?.choices?.[0]?.message?.content?.trim() || ''
  const cleaned = content.startsWith('```') ? content.replace(/^```json?\s*|\s*```$/g, '') : content

  let mapped
  try {
    mapped = JSON.parse(cleaned)
  } catch {
    throw new Error(`Could not parse DeepSeek response: ${content.slice(0, 200)}`)
  }

  if (!Array.isArray(mapped) || mapped.length !== rawSectors.length) {
    throw new Error(`Expected ${rawSectors.length} results, got ${mapped?.length}`)
  }

  return mapped
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Fetching distinct sector values from deals...`)

  const { rows: distinctRows } = await query(
    `SELECT DISTINCT sector FROM deals WHERE sector IS NOT NULL AND sector <> '' ORDER BY sector`,
    []
  )

  const rawSectors = distinctRows.map(r => r.sector)
  console.log(`Found ${rawSectors.length} distinct sector values.\n`)

  if (rawSectors.length === 0) {
    console.log('✅ No sectors to normalize.')
    process.exit(0)
  }

  // Already-canonical values — skip mapping for these
  const canonicalSet = new Set(CANONICAL_SECTORS)
  const alreadyClean = rawSectors.filter(s => canonicalSet.has(s))
  const needsMapping = rawSectors.filter(s => !canonicalSet.has(s))

  console.log(`✅ Already canonical: ${alreadyClean.length}`)
  console.log(`🔄 Need mapping:      ${needsMapping.length}\n`)

  if (needsMapping.length === 0) {
    console.log('✅ All sectors are already canonical. Nothing to do.')
    process.exit(0)
  }

  // Batch into chunks of 30 to avoid huge prompts
  const BATCH_SIZE = 30
  const mappingTable = {} // rawSector → canonicalSector

  for (let i = 0; i < needsMapping.length; i += BATCH_SIZE) {
    const batch = needsMapping.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(needsMapping.length / BATCH_SIZE)
    console.log(`📡 Mapping batch ${batchNum}/${totalBatches} (${batch.length} sectors)...`)
    const mapped = await mapSectorsToCanonical(batch)
    batch.forEach((raw, idx) => {
      mappingTable[raw] = mapped[idx]
    })
    // Brief pause between batches to avoid TLS connection pressure
    if (i + BATCH_SIZE < needsMapping.length) {
      await new Promise(r => setTimeout(r, 1500))
    }
  }

  // Print the full mapping table
  console.log('\n📋 Mapping table:')
  console.log('─'.repeat(70))
  const maxLen = Math.max(...needsMapping.map(s => s.length))
  for (const [raw, canonical] of Object.entries(mappingTable)) {
    const arrow = raw === canonical ? '✅ (unchanged)' : `→ "${canonical}"`
    console.log(`  "${raw.padEnd(maxLen)}" ${arrow}`)
  }
  console.log('─'.repeat(70))

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — no changes written to DB.')
    console.log('    Run without --dry-run to apply changes.\n')
    process.exit(0)
  }

  // Apply updates
  console.log('\n💾 Applying updates to DB...')
  let updated = 0

  let skipped = 0

  for (const [raw, canonical] of Object.entries(mappingTable)) {
    if (raw === canonical) {
      skipped++
      continue
    }
    const { rowCount } = await query(
      `UPDATE deals SET sector = $1, updated_at = now() WHERE sector = $2`,
      [canonical, raw]
    )
    console.log(`  "${raw}" → "${canonical}" (${rowCount} rows)`)
    updated += rowCount
  }

  console.log(`\n✅ Done!`)
  console.log(`   Rows updated:  ${updated}`)
  console.log(`   Already clean: ${alreadyClean.length + skipped}`)
  process.exit(0)
}

main()
  .then(() => closeDb())
  .catch(err => {
    console.error('\n❌ Error:', err?.message || String(err))
    console.error(err)
    closeDb().finally(() => process.exit(1))
  })
