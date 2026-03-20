import { embed } from '../embeddings.js'
import { retrieveByVector } from '../retrieval.js'

function buildContext(meetings, mode) {
  if (!meetings?.length) return 'No meeting transcripts available.'
  const header =
    mode === 'fallback_semantic'
      ? 'These are the closest matching meeting transcripts I could find; they may not be about the exact company or question.\n\n'
      : ''

  const body = meetings
    .map((m, i) => {
      const label = m.source_file_name ? `[${m.source_file_name}]` : `[Meeting ${i + 1}]`
      const companyTag = m.company ? ` (${m.company})` : ''
      return `${label}${companyTag}\n${m.transcript}`
    })
    .join('\n\n---\n\n')

  return header + body
}

export const meetingSearchTool = {
  id: 'meeting_search',
  description: 'Searches ingested meeting transcripts relevant to the user query. Optionally filter by company name for company-specific questions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      company: { type: 'string', description: 'Optional company name to filter transcripts' },
      limit: { type: 'number' }
    },
    required: ['query']
  },
  async execute({ session, input }) {
    const query = input?.query ?? ''
    const company = input?.company ?? null
    const limit = Number.isFinite(input?.limit) && input.limit > 0 ? input.limit : 5

    const queryEmbedding = await embed(query)
    const meetings = await retrieveByVector(queryEmbedding, limit, company)

    let mode = 'direct'
    if (!meetings || meetings.length === 0) {
      mode = 'none'
    }

    const context =
      mode === 'none'
        ? 'No meeting transcripts available.'
        : buildContext(meetings, mode === 'fallback_semantic' ? 'fallback_semantic' : 'direct')

    const payload = { context, meetings, mode }

    if (session && session.toolResults) {
      session.toolResults.meeting_search = payload
    }

    return payload
  }
}

