import { callWithTools } from './llm.js'

const ROUTER_SYSTEM_PROMPT = `You are a routing assistant for a venture capital CRM called Jarvis.
Your ONLY job is to decide which tools (if any) to call based on the user's message.

Available tools:
- meeting_search: searches meeting transcripts. Use whenever the user asks about a topic, conversation, or what was discussed.
  - Always set "query" to the user's question.
  - If a SPECIFIC company is mentioned by name, also set "company" to that company name.
- deal_lookup_by_company: fetches structured CRM data for a SPECIFIC named company (score, stage, status, POC, sector, risks, etc). Use when the user asks about a specific company's details.
- list_all_deals: fetches all deals (optionally filtered by status). Use for broad pipeline questions like "what companies are in portfolio?", "how many active deals?", "show all deals", "what's the average score?".
- sheet_query: queries the WEH Ventures Google Sheet. ALWAYS set "tab" explicitly. Can be called multiple times for cross-tab questions.

  Sheet tab schemas (exact columns):
  (1) tab="Sheet1" — INBOUND contacts log.
      Columns: Timestamp (date), Name, Industry, Description, Logged By, Team Meeting, Notes.
      Use for: inbound leads, who logged what, lead notes, inbound count by month/person.

  (2) tab="Outbound Contacts" — Outbound outreach log.
      Columns: Date, Name, Company Name, Industry, Description, Logged By, Reverted?, Email, Remarks, Team Meeting.
      Use for: outbound contacts, who we reached out to, outreach by date/person.

  (3) tab="Referrals" — Referral tracking.
      Columns: Date, Name, Company Name, Industry, Description, Direction (Inbound/Outbound), Logged By, Reverted?, Email, Remarks, Priority, Team Meeting.
      Use for: referrals, referral direction, priority referrals.

  (4) tab="Team meetings" — Deal pipeline evaluations.
      Columns: Company, Date, POC, Sector, Status (Pass/IC/Track/Founder watch), "Why is this exciting?", Risks, "Conviction Score (on 10)", "Reasons for Pass", "Reasons to watch", "Action required".
      Use for: conviction scores, deal status, pass/watch reasons, IC decisions, sector trends, POC.

  For sheet_query, optionally set:
    - filterMonth: month name (e.g. "March") — use when question mentions a month
    - filterYear: 4-digit year (e.g. "2025") — use when question mentions a year
    - filterKeyword: company name or text — use when question mentions a specific company or keyword

Rules:
- For company-specific questions: call BOTH meeting_search (with company set) AND deal_lookup_by_company.
- For broad pipeline questions: call list_all_deals only (no transcript search needed).
- For topic searches with no specific company: call meeting_search (without company).
- For sheet-specific questions (conviction scores, inbound/outbound contacts, referrals, explicit "in the sheet"): call sheet_query with the correct tab.
  - If user asks about multiple tabs (e.g. "compare inbound vs outbound"): call sheet_query TWICE with different tabs.
  - Always set filterMonth/filterYear if the question implies a time range.
- If it's a simple conversational follow-up with no new data needed, call no tools.
- Never call list_all_deals and deal_lookup_by_company for the same query.`

/**
 * Async LLM-based planner.
 * Sends the user message + tool definitions to DeepSeek and returns
 * { action, tools } where tools is an array of { id, input } objects.
 */
export async function planWithLLM({ tools, userMessage, historyBlob }) {
  const trimmed = (userMessage || '').trim()
  if (!trimmed) return { action: 'answer_direct', tools: [] }

  const messages = [{ role: 'system', content: ROUTER_SYSTEM_PROMPT }]

  // Include condensed recent history so the router can resolve pronouns
  if (historyBlob) {
    messages.push({
      role: 'user',
      content: `Recent conversation context (for reference resolution only):\n${historyBlob.slice(0, 1500)}`
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
