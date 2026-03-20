import 'dotenv/config'
import { google } from 'googleapis'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sql, formatVector, initSchema } from '../db/neon.js'
import { embed } from '../services/embeddings.js'

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID
const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS

const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document'

function getDriveClient() {
  if (!CREDENTIALS_PATH) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS path is required')
  }
  const keyPath = join(process.cwd(), CREDENTIALS_PATH)
  const key = JSON.parse(readFileSync(keyPath, 'utf8'))
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  })
  return google.drive({ version: 'v3', auth })
}

async function listFilesInFolder(drive, folderId) {
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 100
  })
  return data.files || []
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

async function getDocumentText(drive, fileId, mimeType) {
  if (mimeType === GOOGLE_DOCS_MIME) {
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'stream' }
    )
    const buf = await streamToBuffer(res.data)
    return buf.toString('utf8')
  }
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  )
  const buf = await streamToBuffer(res.data)
  return buf.toString('utf8')
}

async function alreadyIngested(driveFileId) {
  const rows = await sql`SELECT 1 FROM meetings WHERE drive_file_id = ${driveFileId} LIMIT 1`
  return rows.length > 0
}

async function ingest() {
  if (!FOLDER_ID) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required')

  await initSchema()
  const drive = getDriveClient()
  const files = await listFilesInFolder(drive, FOLDER_ID)

  let processed = 0
  let skipped = 0

  for (const file of files) {
    if (await alreadyIngested(file.id)) {
      skipped++
      continue
    }
    let text
    try {
      text = await getDocumentText(drive, file.id, file.mimeType || '')
    } catch (e) {
      console.warn(`Skip ${file.name} (${file.id}): could not fetch text - ${e.message}`)
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
        VALUES (${file.id}, ${file.name ?? null}, ${text}, ${vectorStr}::vector)
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
