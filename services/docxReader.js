import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import mammoth from 'mammoth'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_DOCS_DIR = join(__dirname, '../docs')

function inferMeetingDateFromName(fileName) {
  const match = fileName.match(/(\d{4})_(\d{2})_(\d{2})/)
  if (!match) return null
  const [, year, month, day] = match
  return `${year}-${month}-${day}`
}

export function getDefaultDocsDir() {
  return DEFAULT_DOCS_DIR
}

export function listDocxFiles(baseDir = DEFAULT_DOCS_DIR) {
  const entries = readdirSync(baseDir, { withFileTypes: true })
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.docx')
    )
    .map((e) => ({
      name: e.name,
      path: join(baseDir, e.name)
    }))
}

export async function readDocxFile(file) {
  const buffer = readFileSync(file.path)
  const result = await mammoth.extractRawText({ buffer })
  const text = result.value || ''

  const meetingDate = inferMeetingDateFromName(file.name)

  return {
    text,
    metadata: {
      fileName: file.name,
      meetingDate
    }
  }
}

