import 'dotenv/config'
import { initSchema, sql } from '../db/neon.js'
import { ingestDocs } from '../services/ingestDocs.js'

async function main() {
  await initSchema()
  const shouldClear = (process.env.CLEAR_DEALS_BEFORE_INGEST ?? 'true')
    .toLowerCase()
    .trim() !== 'false'

  if (shouldClear) {
    await sql`TRUNCATE TABLE deals RESTART IDENTITY CASCADE`
    console.log('Cleared deals (and dependents) before ingestion.')
  }
  const result = await ingestDocs({ dryRun: false })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

