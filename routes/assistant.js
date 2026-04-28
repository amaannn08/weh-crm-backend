import { Router } from 'express'
import { streamChat } from '../services/llm.js'
import { sql } from '../db/neon.js'
import { createSession } from '../services/session.js'
import { meetingSearchTool } from '../services/tools/meetingSearchTool.js'
import { dealLookupByCompanyTool } from '../services/tools/dealLookupTool.js'
import { listAllDealsTool } from '../services/tools/listAllDealsTool.js'
import { sheetQueryTool } from '../services/tools/sheetQueryTool.js'
import { planWithLLM } from '../services/planner.js'

const router = Router()

const SYSTEM_PROMPT = `You are Jarvis, an AI assistant for a venture capital CRM (WEH Ventures).

You have access to three kinds of information:
- MEETING TRANSCRIPTS (GROUND TRUTH): verbatim transcripts of investor calls.
- COMPANY DATA / PIPELINE DATA (STRUCTURED): deal records from the CRM database.
- GOOGLE SHEET DATA (STRUCTURED): live data from the WEH Ventures tracking sheet.
  The sheet has 4 tabs: INBOUND CONTACTS LOG (Sheet1), OUTBOUND CONTACTS LOG, REFERRALS LOG, DEAL PIPELINE EVALUATIONS.

Rules:
- Treat MEETING TRANSCRIPTS, COMPANY DATA, and GOOGLE SHEET DATA as your factual sources.
- CRITICAL: Trust the numbers exactly as written in the data provided. Do not guess or estimate.
- VERY IMPORTANT: DO NOT mention the internal name of the data source (e.g., "GOOGLE SHEET DATA", "PIPELINE DATA", "CRM", "COMPANY DATA") in your response. Present the information seamlessly and naturally as if you simply know the answer.
- Use CHAT HISTORY only to resolve references (like "they", "their"), not as evidence.
- Do NOT invent names, numbers, or facts not present in the provided data.
- If the data does not contain the answer, say so clearly.
- Be concise and directly answer the user's latest question.
- When presenting pipeline or sheet data, format it clearly (lists, tables in markdown).`

// ─── SSE helpers ───────────────────────────────────────────────────────────────

function sse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function getToolLabel(toolId, input = {}) {
  switch (toolId) {
    case 'sheet_query': {
      const tab = input.tab || 'sheet'
      let label = `Querying ${tab}`
      if (input.filterMonth) label += ` for ${input.filterMonth}`
      if (input.filterYear)  label += ` ${input.filterYear}`
      return label + '…'
    }
    case 'meeting_search':
      return input.company
        ? `Searching transcripts for ${input.company}…`
        : 'Searching meeting transcripts…'
    case 'deal_lookup_by_company':
      return input.company
        ? `Looking up ${input.company} in CRM…`
        : 'Looking up company in CRM…'
    case 'list_all_deals':
      return 'Loading full deal pipeline…'
    default:
      return `Running ${toolId}…`
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  const { message, conversationId } = req.body
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) required' })
  }

  const { session, conversationTitle, historyBlob } = await createSession({
    conversationId,
    userMessage: message
  })

  // ── SSE headers ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Conversation-Id', session.conversationId)
  res.flushHeaders?.()

  const availableTools = [meetingSearchTool, dealLookupByCompanyTool, listAllDealsTool, sheetQueryTool]

  let meetingContext = 'No meeting transcripts available.'
  let meetingMode = 'none'
  let companyDataSection = ''
  let pipelineDataSection = ''
  let sheetDataSection = ''
  let fullAssistantContent = ''

  try {
    // ── Plan ──────────────────────────────────────────────────────────────────
    const plan = await planWithLLM({ tools: availableTools, userMessage: message, historyBlob })

    // ── Execute tools with SSE status events ─────────────────────────────────
    if (plan.action === 'call_tools' && Array.isArray(plan.tools) && plan.tools.length > 0) {
      for (let i = 0; i < plan.tools.length; i++) {
        const step = plan.tools[i]
        const tool = availableTools.find((t) => t.id === step.id)
        if (!tool) continue

        const key = `${step.id}_${i}`
        const label = getToolLabel(step.id, step.input)

        sse(res, { type: 'tool_start', tool: step.id, key, label })

        const result = await tool.execute({ session, input: step.input })

        sse(res, { type: 'tool_done', key })

        // Accumulate results
        if (tool.id === 'meeting_search' && result) {
          if (result.context) meetingContext = result.context
          if (result.mode)    meetingMode    = result.mode
        }

        if (tool.id === 'deal_lookup_by_company' && result?.deals?.length > 0) {
          const lines = result.deals.map((d, idx) => {
            const parts = [`Deal ${idx + 1}:`]
            if (d.company)              parts.push(`Company: ${d.company}`)
            if (d.stage)                parts.push(`Stage: ${d.stage}`)
            if (d.sector)               parts.push(`Sector: ${d.sector}`)
            if (d.status)               parts.push(`Status: ${d.status}`)
            if (d.poc)                  parts.push(`POC: ${d.poc}`)
            if (d.meeting_date)         parts.push(`Meeting date: ${d.meeting_date}`)
            if (d.conviction_score != null) parts.push(`Conviction score: ${d.conviction_score}`)
            if (d.founder_final_score != null) parts.push(`Founder score: ${d.founder_final_score}`)
            if (d.exciting_reason)      parts.push(`Why exciting: ${d.exciting_reason}`)
            if (d.risks)                parts.push(`Risks: ${d.risks}`)
            return `- ${parts.join(' | ')}`
          })
          companyDataSection = `COMPANY DATA (FROM CRM):\n\n${lines.join('\n')}\n\n`
        }

        if (tool.id === 'sheet_query' && result?.sheetContext) {
          sheetDataSection += `GOOGLE SHEET DATA (LIVE):\n\n${result.sheetContext}\n\n`
        }

        if (tool.id === 'list_all_deals') {
          if (result?.total_deals !== undefined) {
             const filterLabel = result.status && result.status !== 'all' ? `Status filter: ${result.status}` : 'All deals'
             const yearLabel = result.year && result.year !== 'all' ? `Year: ${result.year}` : 'All time'
             pipelineDataSection = `PIPELINE DATA (${filterLabel}, ${yearLabel}):\n\nTotal count of deals matching criteria: ${result.total_deals}\n\n`
          } else if (result?.deals) {
            const filterLabel = result.status && result.status !== 'all'
              ? `Status filter: ${result.status}`
              : 'All deals'
            const lines = result.deals.map((d) => {
              const parts = []
              if (d.company)               parts.push(d.company)
              if (d.status)                parts.push(`[${d.status}]`)
              if (d.sector)                parts.push(`sector: ${d.sector}`)
              if (d.founder_final_score != null) parts.push(`score: ${d.founder_final_score}`)
              if (d.poc)                   parts.push(`POC: ${d.poc}`)
              return `- ${parts.join(' | ')}`
            })
            pipelineDataSection = `PIPELINE DATA (${filterLabel} — ${result.deals.length} deals):\n\n${lines.join('\n')}\n\n`
          }
        }
      }
    }

    // ── Build prompt ──────────────────────────────────────────────────────────
    const meetingHeaderPrefix =
      meetingMode === 'fallback_semantic'
        ? 'These are the closest matching transcripts found; they may not be about the exact question.\n\n'
        : ''

    // Only include meeting transcripts if they were actually retrieved
    const meetingSection = meetingContext !== 'No meeting transcripts available.'
      ? `MEETING TRANSCRIPTS (GROUND TRUTH):\n\n${meetingHeaderPrefix}${meetingContext}\n\n`
      : ''
    const historySection = historyBlob
      ? `CHAT HISTORY (CONVERSATION ONLY — NOT GROUND TRUTH):\n\n${historyBlob}\n\n`
      : ''
    const taskSection = `TASK:\n\nAnswer the user's latest question using ONLY the data provided above. Trust the numbers exactly as written in the data. If a specific count (like COUNT BY YEAR or Total count of deals) is present, use that exact number. Do not estimate or assume 0 if data is present. Do not mention internal data source names in your response.\n\nUser question:\n${message}`

    // Sheet data comes first so it isn't buried under transcripts
    const userContent = `${sheetDataSection}${companyDataSection}${pipelineDataSection}${meetingSection}${historySection}${taskSection}`

    // ── Stream LLM answer ─────────────────────────────────────────────────────
    await streamChat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userContent   }
      ],
      (chunk) => {
        fullAssistantContent += chunk
        sse(res, { type: 'text', content: chunk })
      }
    )

    sse(res, { type: 'done' })
    res.end()

    // ── Persist messages ──────────────────────────────────────────────────────
    await sql`
      INSERT INTO conversation_messages (conversation_id, role, content)
      VALUES (${session.conversationId}::uuid, 'user', ${message})
    `
    await sql`
      INSERT INTO conversation_messages (conversation_id, role, content)
      VALUES (${session.conversationId}::uuid, 'assistant', ${fullAssistantContent})
    `
    const normalizedTitle = (conversationTitle || '').trim()
    if (!normalizedTitle || normalizedTitle === 'New session') {
      const firstLine = message.split('\n')[0] ?? ''
      const newTitle  = firstLine.slice(0, 80).trim() || 'New session'
      await sql`UPDATE conversations SET title = ${newTitle} WHERE id = ${session.conversationId}::uuid`
    }

  } catch (err) {
    console.error('[assistant] error handling chat:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Assistant error' })
    } else {
      sse(res, { type: 'error', message: err.message || 'Assistant error' })
      res.end()
    }
  }
})

export default router
