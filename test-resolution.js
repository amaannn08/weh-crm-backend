import { resolveCompanyEntity } from './services/companyEntityResolution.js'
import { initSchema } from './db/neon.js'

async function run() {
  await initSchema()
  console.log('Testing resolution with known company...')
  const res1 = await resolveCompanyEntity('SpaceX Inc', 'Elon Musk')
  console.log('Res 1:', res1)

  console.log('Testing resolution with no name but founder...')
  const res2 = await resolveCompanyEntity('', 'Sam Altman')
  console.log('Res 2:', res2)

  console.log('Testing resolution with neither...')
  const res3 = await resolveCompanyEntity('', '')
  console.log('Res 3:', res3)

  process.exit(0)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
