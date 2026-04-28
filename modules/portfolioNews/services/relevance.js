/**
 * relevance.js
 *
 * Uses DeepSeek to check whether a news article is actually about a specific
 * portfolio company, not just a keyword false-positive.
 *
 * Returns { relevant: boolean, reason: string }
 *
 * Designed to be cheap:
 *  - Very short prompt (title + summary, max 500 chars)
 *  - Asks for a single JSON object {relevant, reason}
 *  - Non-streaming, one pass, no retry (failures default to `relevant: true`
 *    so we don't drop real news on transient LLM errors)
 */

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'

/**
 * @param {{ title: string, summary: string, companyName: string, companySlug: string }} params
 * @returns {Promise<{ relevant: boolean, reason: string }>}
 */
export async function checkRelevance({ title, summary, companyName, companySlug }) {
  if (!DEEPSEEK_API_KEY) {
    // Gracefully skip if LLM key is not configured
    console.warn('[relevance] DEEPSEEK_API_KEY not set — skipping LLM relevance check')
    return { relevant: true, reason: 'skipped: no api key' }
  }

  const articleText = [title, summary].filter(Boolean).join(' ').slice(0, 500)

  const prompt = `You are checking whether a news article is actually about a specific startup company.

Company: "${companyName}" (slug: "${companySlug}")

Article:
"""
${articleText}
"""

Is this article genuinely about the company "${companyName}"? It is NOT relevant if it only coincidentally mentions a common word that matches the company name, or is about an unrelated organization.

Reply with ONLY valid JSON in exactly this format:
{"relevant": true, "reason": "short reason"}
or
{"relevant": false, "reason": "short reason"}`

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'user', content: prompt }
        ],
        stream: false,
        max_tokens: 80
      }),
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      console.warn(`[relevance] LLM request failed (${response.status}) — defaulting to relevant`)
      return { relevant: true, reason: `llm_error: http ${response.status}` }
    }

    const json = await response.json()
    const content = json?.choices?.[0]?.message?.content?.trim() ?? ''

    // Strip markdown code fences if model adds them
    const cleaned = content.startsWith('```')
      ? content.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim()
      : content

    const parsed = JSON.parse(cleaned)
    const relevant = parsed.relevant === true
    const reason = typeof parsed.reason === 'string' ? parsed.reason : ''
    return { relevant, reason }
  } catch (err) {
    // On any error (timeout, JSON parse failure), default to relevant
    // to avoid silently dropping legitimate news
    console.warn(`[relevance] LLM check error for "${companyName}" — defaulting to relevant:`, err?.message)
    return { relevant: true, reason: `llm_error: ${err?.message}` }
  }
}
