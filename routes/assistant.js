import { Router } from 'express'
import { streamChat } from '../services/llm.js'
import { sql } from '../db/neon.js'
import { createSession } from '../services/session.js'
import { meetingSearchTool } from '../services/tools/meetingSearchTool.js'
import { dealLookupByCompanyTool } from '../services/tools/dealLookupTool.js'
import { listAllDealsTool } from '../services/tools/listAllDealsTool.js'
import { planWithLLM } from '../services/planner.js'

const router = Router()

const SYSTEM_PROMPT = `You are Jarvis, an AI assistant for a venture capital CRM (WEH Ventures).

You have access to two kinds of information:
- MEETING TRANSCRIPTS (GROUND TRUTH): verbatim transcripts of investor calls.
- COMPANY DATA / PIPELINE DATA (STRUCTURED): deal records from the CRM database.

Rules:
- Treat MEETING TRANSCRIPTS and COMPANY DATA as your factual sources.
- Use CHAT HISTORY only to resolve references (like "they", "their"), not as evidence.
- Do NOT invent names, numbers, or facts not present in the provided data.
- If the data does not contain the answer, say so clearly.
- Be concise and directly answer the user's latest question.
- When presenting pipeline data, format it clearly (lists, tables in markdown).`

router.post('/chat', async (req, res) => {
  const { message, conversationId } = req.body
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) required' })
  }

  try {
    const { session, conversationTitle, historyBlob } = await createSession({
      conversationId,
      userMessage: message
    })

    const availableTools = [meetingSearchTool, dealLookupByCompanyTool, listAllDealsTool]

    // ── LLM routing: decide which tools to call ──────────────────────────────
    const plan = await planWithLLM({
      tools: availableTools,
      userMessage: message,
      historyBlob
    })

    // ── Execute planned tools ────────────────────────────────────────────────
    let meetingContext = 'No meeting transcripts available.'
    let meetingMode = 'none'
    let companyDataSection = ''
    let pipelineDataSection = ''

    if (plan.action === 'call_tools' && Array.isArray(plan.tools) && plan.tools.length > 0) {
      for (const step of plan.tools) {
        const tool = availableTools.find((t) => t.id === step.id)
        if (!tool) continue

        const result = await tool.execute({ session, input: step.input })

        // meeting_search
        if (tool.id === 'meeting_search' && result) {
          if (result.context) meetingContext = result.context
          if (result.mode) meetingMode = result.mode
        }

        // deal_lookup_by_company
        if (tool.id === 'deal_lookup_by_company' && result?.deals?.length > 0) {
          const lines = result.deals.map((d, idx) => {
            const parts = [`Deal ${idx + 1}:`]
            if (d.company) parts.push(`Company: ${d.company}`)
            if (d.stage) parts.push(`Stage: ${d.stage}`)
            if (d.sector) parts.push(`Sector: ${d.sector}`)
            if (d.status) parts.push(`Status: ${d.status}`)
            if (d.poc) parts.push(`POC: ${d.poc}`)
            if (d.meeting_date) parts.push(`Meeting date: ${d.meeting_date}`)
            if (d.conviction_score != null) parts.push(`Conviction score: ${d.conviction_score}`)
            if (d.founder_final_score != null) parts.push(`Founder score: ${d.founder_final_score}`)
            if (d.exciting_reason) parts.push(`Why exciting: ${d.exciting_reason}`)
            if (d.risks) parts.push(`Risks: ${d.risks}`)
            return `- ${parts.join(' | ')}`
          })
          companyDataSection = `COMPANY DATA (FROM CRM):\n\n${lines.join('\n')}\n\n`
        }

        // list_all_deals
        if (tool.id === 'list_all_deals' && result?.deals) {
          const filterLabel = result.status && result.status !== 'all'
            ? `Status filter: ${result.status}`
            : 'All deals'
          const lines = result.deals.map((d) => {
            const parts = []
            if (d.company) parts.push(d.company)
            if (d.status) parts.push(`[${d.status}]`)
            if (d.sector) parts.push(`sector: ${d.sector}`)
            if (d.founder_final_score != null) parts.push(`score: ${d.founder_final_score}`)
            if (d.poc) parts.push(`POC: ${d.poc}`)
            return `- ${parts.join(' | ')}`
          })
          pipelineDataSection = `PIPELINE DATA (${filterLabel} — ${result.deals.length} deals):\n\n${lines.join('\n')}\n\n`
        }
      }
    }

    // ── Build context for final answer ───────────────────────────────────────
    const hasHistory = !!historyBlob
    const meetingHeaderPrefix =
      meetingMode === 'fallback_semantic'
        ? 'These are the closest matching meeting transcripts found; they may not be about the exact company or question.\n\n'
        : ''

    const meetingSection = `MEETING TRANSCRIPTS (GROUND TRUTH):\n\n${meetingHeaderPrefix}${meetingContext}\n\n`
    const historySection = hasHistory
      ? `CHAT HISTORY (CONVERSATION ONLY — NOT GROUND TRUTH):\n\n${historyBlob}\n\n`
      : ''
    const taskSection = `TASK:\n\nAnswer the user's latest question using the data provided above. Use chat history only to resolve references. If the data does not contain the answer, say you don't know.\n\nUser question:\n${message}`

    const userContent = `${meetingSection}${companyDataSection}${pipelineDataSection}${historySection}${taskSection}`

    // ── Stream final answer ───────────────────────────────────────────────────
    let fullAssistantContent = ''
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Transfer-Encoding', 'chunked')
    res.setHeader('X-Conversation-Id', session.conversationId)
    res.flushHeaders?.()

    await streamChat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      (chunk) => {
        fullAssistantContent += chunk
        res.write(chunk)
      }
    )
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
      const newTitle = firstLine.slice(0, 80).trim() || 'New session'
      await sql`UPDATE conversations SET title = ${newTitle} WHERE id = ${session.conversationId}::uuid`
    }
  } catch (err) {
    console.error('[assistant] error handling chat', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Assistant error' })
    } else {
      res.end()
    }
  }
})

export default router
