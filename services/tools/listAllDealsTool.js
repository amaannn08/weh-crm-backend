import { sql } from '../../db/neon.js'

export const listAllDealsTool = {
    id: 'list_all_deals',
    description:
        'Fetches all deals from the database. Use this for broad pipeline questions like "which companies are in portfolio?", "how many active deals?", "what is the average score?", or when the user asks to list/summarise the pipeline.',
    inputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                description:
                    'Optional status filter. One of: Portfolio, Active Diligence, Pass, Watch, or New. Leave blank to fetch all deals.'
            }
        },
        required: []
    },
    async execute({ input }) {
        const status = (input?.status || '').trim()

        const deals = status
            ? await sql`
          SELECT id, company, sector, status, stage,
                 conviction_score, founder_final_score, meeting_date,
                 exciting_reason, risks, poc
          FROM deals
          WHERE LOWER(status) = LOWER(${status})
          ORDER BY founder_final_score DESC NULLS LAST, created_at DESC
        `
            : await sql`
          SELECT id, company, sector, status, stage,
                 conviction_score, founder_final_score, meeting_date,
                 exciting_reason, risks, poc
          FROM deals
          ORDER BY founder_final_score DESC NULLS LAST, created_at DESC
        `

        return { deals, status: status || 'all' }
    }
}
