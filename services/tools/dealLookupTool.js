import { sql } from '../../db/neon.js'

export const dealLookupByCompanyTool = {
  id: 'deal_lookup_by_company',
  description: 'Fetches structured deal data for a given company name.',
  inputSchema: {
    type: 'object',
    properties: {
      company: { type: 'string' },
      limit: { type: 'number' }
    },
    required: ['company']
  },
  async execute({ session, input }) {
    const rawCompany = (input?.company || '').trim()
    if (!rawCompany) {
      return { deals: [], company: null }
    }

    const limit = Number.isFinite(input?.limit) && input.limit > 0 ? input.limit : 3

    const deals = await sql`
      SELECT
        id,
        company,
        sector,
        status,
        stage,
        conviction_score,
        founder_final_score,
        meeting_date,
        exciting_reason,
        risks
      FROM deals
      WHERE company ILIKE ${rawCompany}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `

    const payload = {
      company: rawCompany,
      deals
    }

    if (session && session.toolResults) {
      session.toolResults.deal_lookup_by_company = payload
    }

    return payload
  }
}

