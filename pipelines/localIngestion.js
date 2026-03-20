import 'dotenv/config'
import { readdirSync, readFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import mammoth from 'mammoth'
import { sql, formatVector, initSchema } from '../db/neon.js'
import { embed } from '../services/embeddings.js'

const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR
const ALLOWED_EXT = ['.txt', '.md', '.docx']

function listTextFiles(dir) {
  const resolved = isAbsolute(dir) ? dir : join(process.cwd(), dir)
  const entries = readdirSync(resolved, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && ALLOWED_EXT.some((ext) => e.name.toLowerCase().endsWith(ext)))
    .map((e) => ({ name: e.name, path: join(resolved, e.name), relativePath: e.name }))
}

async function readFileText(file) {
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))
  if (ext === '.docx') {
    const buf = readFileSync(file.path)
    const result = await mammoth.extractRawText({ buffer: buf })
    return result.value
  }
  return readFileSync(file.path, 'utf8')
}

async function alreadyIngested(sourceId) {
  const rows = await sql`SELECT 1 FROM meetings WHERE drive_file_id = ${sourceId} LIMIT 1`
  return rows.length > 0
}

const INIT_SCHEMA_RETRIES = 5
const INIT_SCHEMA_DELAY_MS = 5000

async function initSchemaWithRetry() {
  let lastErr
  for (let attempt = 1; attempt <= INIT_SCHEMA_RETRIES; attempt++) {
    try {
      await initSchema()
      return
    } catch (err) {
      lastErr = err
      if (attempt < INIT_SCHEMA_RETRIES) {
        console.warn(`DB connection attempt ${attempt} failed, retrying in ${INIT_SCHEMA_DELAY_MS / 1000}s...`)
        await new Promise((r) => setTimeout(r, INIT_SCHEMA_DELAY_MS))
      }
    }
  }
  throw lastErr
}

async function ingest() {
  if (!TRANSCRIPTS_DIR) throw new Error('TRANSCRIPTS_DIR is required')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required')

  await initSchemaWithRetry()
  const files = listTextFiles(TRANSCRIPTS_DIR)

  let processed = 0
  let skipped = 0

  for (const file of files) {
    if (await alreadyIngested(file.relativePath)) {
      skipped++
      continue
    }
    let text
    try {
      text = await readFileText(file)
    } catch (e) {
      console.warn(`Skip ${file.name}: could not read file - ${e.message}`)
      continue
    }
    if (!text?.trim()) {
      console.warn(`Skip ${file.name}: empty content`)
      continue
    }
    try {
      const embedding = await embed(text)
      const vectorStr = formatVector(embedding)
      await sql`
        INSERT INTO meetings (drive_file_id, source_file_name, transcript, embedding)
        VALUES (${file.relativePath}, ${file.name}, ${text}, ${vectorStr}::vector)
      `
      processed++
      console.log(`Ingested: ${file.name}`)
    } catch (e) {
      console.warn(`Failed to embed/insert ${file.name}: ${e.message}`)
    }
  }

  console.log(`Done. Ingested: ${processed}, skipped (already present): ${skipped}`)
}

ingest().catch((err) => {
  console.error(err)
  process.exit(1)
})
