import { callWithTools } from './llm.js'

const ROUTER_SYSTEM_PROMPT = `You are a routing assistant for a venture capital CRM called Jarvis.
Your ONLY job is to decide which tools (if any) to call based on the user's message.

Available tools:
- meeting_search: searches meeting transcripts. Use whenever the user asks about a topic, conversation, or what was discussed.
  - Always set "query" to the user's question.
  - If a SPECIFIC company is mentioned by name, also set "company" to that company name so transcripts are filtered to that company only.
- deal_lookup_by_company: fetches structured CRM data for a SPECIFIC named company (score, stage, status, POC, sector, risks, etc). Use when the user asks about a specific company's details.
- list_all_deals: fetches all deals (optionally filtered by status). Use for broad pipeline questions like "what companies are in portfolio?", "how many active deals?", "show all deals", "what's the average score?".

Rules:
- For company-specific questions: call BOTH meeting_search (with company set) AND deal_lookup_by_company.
- For broad pipeline questions: call list_all_deals only (no transcript search needed).
- For topic searches with no specific company: call meeting_search (without company).
- If it's a simple conversational follow-up with no new company or topic, call no tools.
- Never call list_all_deals and deal_lookup_by_company for the same query.`

/**
 * Async LLM-based planner.
 * Sends the user message + tool definitions to DeepSeek and returns
 * { action, tools } where tools is an array of { id, input } objects.
 */
export async function planWithLLM({ tools, userMessage, historyBlob }) {
  const trimmed = (userMessage || '').trim()
  if (!trimmed) return { action: 'answer_direct', tools: [] }

  // Build messages for the routing call
  const messages = [{ role: 'system', content: ROUTER_SYSTEM_PROMPT }]

  // Include a condensed version of recent history so the router understands pronouns
  if (historyBlob) {
    messages.push({
      role: 'user',
      content: `Recent conversation context (for pronoun resolution only):\n${historyBlob.slice(0, 1500)}`
    })
    messages.push({
      role: 'assistant',
      content: 'Understood. I will use this context to resolve references in the next message.'
    })
  }

  messages.push({ role: 'user', content: trimmed })

  let routerMessage
  try {
    routerMessage = await callWithTools(messages, tools)
  } catch (err) {
    console.error('[planner] LLM router call failed, falling back to meeting_search only:', err.message)
    return {
      action: 'call_tools',
      tools: [{ id: 'meeting_search', input: { query: trimmed } }]
    }
  }

  const toolCalls = routerMessage?.tool_calls
  if (!toolCalls || toolCalls.length === 0) {
    // Model decided no tools needed — answer from history/context
    return { action: 'answer_direct', tools: [] }
  }

  const plannedTools = toolCalls.map((tc) => {
    let input = {}
    try {
      input = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments
    } catch {
      input = {}
    }
    return { id: tc.function.name, input }
  })

  return { action: 'call_tools', tools: plannedTools }
}
