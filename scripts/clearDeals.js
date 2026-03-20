import 'dotenv/config'
import { initSchema, sql } from '../db/neon.js'

async function main() {
  await initSchema()

  const withMeetings = process.argv.includes('--meetings')

  if (withMeetings) {
    await sql`TRUNCATE TABLE meetings RESTART IDENTITY CASCADE`
    console.log('Cleared meetings (and dependents) via TRUNCATE CASCADE.')
    return
  }

  await sql`TRUNCATE TABLE deals RESTART IDENTITY CASCADE`
  console.log('Cleared deals (and dependents) via TRUNCATE CASCADE.')
  console.log('Tip: run with --meetings to also clear meetings.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

