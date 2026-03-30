import 'dotenv/config'
import { initSchema } from '../db/neon.js'
import { runIngest } from '../modules/portfolioNews/jobs/ingest.js'

await initSchema()
console.log('Schema ready — starting news ingest...\n')
const result = await runIngest()
console.log('\nResult:', result)
process.exit(0)
