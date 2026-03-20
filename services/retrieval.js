import { sql, formatVector } from '../db/neon.js';

export async function retrieveByVector(queryEmbedding, limit = 5, company = null) {
  const vectorStr = formatVector(queryEmbedding)
  if (company) {
    const rows = await sql`
      SELECT id, transcript, source_file_name, company
      FROM meetings
      WHERE LOWER(TRIM(company)) = LOWER(TRIM(${company}))
      ORDER BY embedding <-> ${vectorStr}::vector
      LIMIT ${limit}
    `
    // If we got results for the specific company, return them
    if (rows.length > 0) return rows
    // Fallback: broad semantic search if no company-specific hits
  }
  const rows = await sql`
    SELECT id, transcript, source_file_name, company
    FROM meetings
    ORDER BY embedding <-> ${vectorStr}::vector
    LIMIT ${limit}
  `
  return rows
}
