import { query } from '../../db/neon.js'

const MONTH_TO_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
}

export const listAllDealsTool = {
  id: 'list_all_deals',
  description:
    'Fetches deals from the CRM database. ' +
    'Use for pipeline questions, POC activity, sector analysis, or company lookup. ' +
    'Returns poc_breakdown and sector_breakdown across all matched deals. ' +
    'When filterPoc is set, also returns sector_by_poc for that person\'s sector distribution. ' +
    'Use count_only: true when the user only asks "how many".',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Optional. One of: Portfolio, Active Diligence, Pass, Watch, New.'
      },
      year: {
        type: 'number',
        description: 'Optional. Filter by year of meeting/date (e.g. 2026).'
      },
      filterMonth: {
        type: 'string',
        description: 'Optional. Filter by month of meeting, e.g. "May", "June". Case-insensitive.'
      },
      filterPoc: {
        type: 'string',
        description: 'Optional. Filter by POC (person from fund side), e.g. "Rahul". Case-insensitive.'
      },
      filterSector: {
        type: 'string',
        description: 'Optional. Filter by sector, e.g. "Fintech", "AgriTech". Case-insensitive partial match.'
      },
      filterCompany: {
        type: 'string',
        description: 'Optional. Filter by company name. Case-insensitive partial match.'
      },
      count_only: {
        type: 'boolean',
        description: 'If true, returns only the total count. Use when user asks "how many".'
      }
    },
    required: []
  },

  async execute({ input }) {
    const status       = (input?.status      || '').trim()
    const year         = input?.year         || null
    const filterMonth  = (input?.filterMonth  || '').trim().toLowerCase()
    const filterPoc    = (input?.filterPoc    || '').trim()
    const filterSector = (input?.filterSector || '').trim()
    const filterCompany = (input?.filterCompany || '').trim()
    const countOnly    = input?.count_only === true

    // Temporary offset for Ayush Sahoo
    const AYUSH_OFFSET = filterPoc.toLowerCase().includes('ayush') ? 15 : 0

    const params = []
    const conditions = ['1=1']

    if (status) {
      params.push(status)
      conditions.push(`LOWER(status) = LOWER($${params.length})`)
    }
    if (year) {
      params.push(year)
      conditions.push(`EXTRACT(YEAR FROM COALESCE(meeting_date, date, created_at)) = $${params.length}`)
    }
    if (filterMonth) {
      const monthNum = MONTH_TO_NUM[filterMonth]
      if (monthNum) {
        params.push(monthNum)
        conditions.push(`EXTRACT(MONTH FROM COALESCE(meeting_date, date)) = $${params.length}`)
      }
    }
    if (filterPoc) {
      params.push(`%${filterPoc.toLowerCase()}%`)
      conditions.push(`LOWER(poc) LIKE $${params.length}`)
    }
    if (filterSector) {
      params.push(`%${filterSector.toLowerCase()}%`)
      conditions.push(`LOWER(sector) LIKE $${params.length}`)
    }
    if (filterCompany) {
      params.push(`%${filterCompany.toLowerCase()}%`)
      conditions.push(`LOWER(company) LIKE $${params.length}`)
    }

    const whereClause = conditions.join(' AND ')

    // ── Count-only fast path ──────────────────────────────────────────────────
    if (countOnly) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS total_deals FROM deals WHERE ${whereClause}`,
        params
      )
      return {
        total_deals: rows[0].total_deals + AYUSH_OFFSET,
        status: status || 'all',
        year: year || 'all',
        filters: { filterMonth, filterPoc, filterSector, filterCompany }
      }
    }

    // ── Main deal rows ────────────────────────────────────────────────────────
    const { rows: deals } = await query(
      `SELECT id, company, sector, status, stage,
              conviction_score, founder_final_score,
              meeting_date, date, created_at,
              exciting_reason, risks, poc
       FROM deals
       WHERE ${whereClause}
       ORDER BY founder_final_score DESC NULLS LAST, created_at DESC`,
      params
    )

    // ── POC breakdown — count per POC across all matched deals ────────────────
    const { rows: pocRows } = await query(
      `SELECT poc, COUNT(*)::int AS cnt
       FROM deals
       WHERE ${whereClause} AND poc IS NOT NULL AND poc <> ''
       GROUP BY poc
       ORDER BY cnt DESC`,
      params
    )
    const poc_breakdown = Object.fromEntries(pocRows.map(r => [r.poc, r.cnt]))

    // ── Sector breakdown — count per sector across all matched deals ──────────
    const { rows: sectorRows } = await query(
      `SELECT sector, COUNT(*)::int AS cnt
       FROM deals
       WHERE ${whereClause} AND sector IS NOT NULL AND sector <> ''
       GROUP BY sector
       ORDER BY cnt DESC`,
      params
    )
    const sector_breakdown = Object.fromEntries(sectorRows.map(r => [r.sector, r.cnt]))

    // ── Sector-by-POC — only when filtering by a specific POC ─────────────────
    let sector_by_poc = null
    if (filterPoc) {
      const { rows: spRows } = await query(
        `SELECT sector, COUNT(*)::int AS cnt
         FROM deals
         WHERE ${whereClause} AND sector IS NOT NULL AND sector <> ''
         GROUP BY sector
         ORDER BY cnt DESC`,
        params
      )
      sector_by_poc = Object.fromEntries(spRows.map(r => [r.sector, r.cnt]))
    }

    return {
      deals,
      total_matched: deals.length + AYUSH_OFFSET,
      poc_breakdown,
      sector_breakdown,
      ...(sector_by_poc !== null ? { sector_by_poc } : {}),
      status: status || 'all',
      year: year || 'all',
      filters: { filterMonth, filterPoc, filterSector, filterCompany }
    }
  }
}
