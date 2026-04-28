import { query } from '../../db/neon.js'

export const listAllDealsTool = {
    id: 'list_all_deals',
    description:
        'Fetches all deals from the database. Use this for broad pipeline questions like "which companies are in portfolio?", "how many active deals?", "what is the average score?", or when the user asks to list/summarise the pipeline. If the user only asks for a count (e.g. "how many deals we talked in 2026"), use count_only: true to avoid fetching too much data.',
    inputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                description:
                    'Optional status filter. One of: Portfolio, Active Diligence, Pass, Watch, or New. Leave blank to fetch all deals.'
            },
            year: {
                type: 'number',
                description: 'Optional year to filter deals (e.g. 2026).'
            },
            count_only: {
                type: 'boolean',
                description: 'If true, only returns the total count of deals matching the criteria, rather than the full list. Use this when the user asks "how many" deals.'
            }
        },
        required: []
    },
    async execute({ input }) {
        const status = (input?.status || '').trim()
        const year = input?.year || null
        const countOnly = input?.count_only === true

        let text = `
          SELECT id, company, sector, status, stage,
                 conviction_score, founder_final_score, meeting_date, date, created_at,
                 exciting_reason, risks, poc
          FROM deals
          WHERE 1=1
        `
        
        if (countOnly) {
            text = `SELECT count(*)::int as total_deals FROM deals WHERE 1=1`
        }

        const params = []

        if (status) {
            params.push(status)
            text += ` AND LOWER(status) = LOWER($${params.length})`
        }

        if (year) {
            params.push(year)
            text += ` AND EXTRACT(YEAR FROM COALESCE(meeting_date, date, created_at)) = $${params.length}`
        }

        if (!countOnly) {
            text += ` ORDER BY founder_final_score DESC NULLS LAST, created_at DESC`
        }

        const { rows } = await query(text, params)

        if (countOnly) {
            return { total_deals: rows[0].total_deals, status: status || 'all', year: year || 'all' }
        }

        return { deals: rows, status: status || 'all', year: year || 'all' }
    }
}
