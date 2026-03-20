import 'dotenv/config'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
if (!DEEPSEEK_API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is required for deal extraction')
}

const MODEL_NAME = process.env.DEAL_EXTRACTION_MODEL || 'deepseek-chat'
const URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parseJsonFromModel(text) {
  const trimmed = text.trim()
  const cleaned = trimmed.startsWith('```')
    ? trimmed.replace(/^```json\s*|\s*```$/g, '')
    : trimmed

  try {
    return JSON.parse(cleaned)
  } catch (err) {
    console.error('Failed to parse deal extraction JSON', { text: trimmed })
    throw new Error('Model did not return valid JSON for deal extraction')
  }
}

async function deepseekChatJson({ systemInstruction, prompt }) {
  const body = {
    model: MODEL_NAME,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: prompt }
    ],
    stream: false
  }

  const response = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `DeepSeek extraction request failed with ${response.status} ${response.statusText}: ${text.slice(
        0,
        200
      )}`
    )
  }

  const json = await response.json()
  const content = json?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('DeepSeek did not return message content for deal extraction')
  }
  return content
}

export async function extractDealFromTranscript({ transcript }) {
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    throw new Error('Transcript is required for deal extraction')
  }

  const MAX_CHARS = 15000
  const trimmed =
    transcript.length > MAX_CHARS
      ? `${transcript.slice(0, MAX_CHARS)}\n\n[TRUNCATED FOR EXTRACTION]`
      : transcript

  const systemInstruction =
    'You are a venture investor assistant extracting structured deal and founder signals from meeting transcripts. ' +
    'Only output strict JSON that matches the requested schema. Do not include any commentary, markdown, or extra keys.'

  const prompt = `
Read the following venture meeting transcript and extract structured signals.

Transcript:
"""
${trimmed}
"""

Return a single JSON object with EXACTLY this structure and key names:
{
  "company": "",
  "founder_name": "",
  "meeting_date": "",          // ISO date YYYY-MM-DD or "" if unknown
  "poc": "",                   // who met them from the fund side
  "sector": "",
  "business_model": "",
  "stage": "",

  "meeting_outcome": {
    "investable": true,
    "pass_reason": "",
    "watch_reason": "",
    "action_required": "",
    "next_steps": ""
  },

  "founder_pitch": {
    "clarity_of_problem": 0,
    "clarity_of_solution": 0,
    "market_understanding": 0,
    "technical_depth": 0,
    "ability_to_handle_questions": 0,
    "adaptability": 0,
    "storytelling": 0,
    "confidence": 0
  },

  "founder_archetype": {
    "label": "",               // short archetype label, e.g. "gritty executor"
    "resilience": 0,
    "ambition": 0,
    "self_awareness": 0,
    "domain_fit": 0,
    "storytelling": 0,
    "evidence": {
      "resilience": "",
      "ambition": "",
      "self_awareness": "",
      "domain_fit": "",
      "storytelling": ""
    }
  },

  "founder_quality_signals": {
    "education_tier": 0,
    "domain_work_experience": 0,
    "seniority_of_roles": 0,
    "previous_startup_experience": 0
  },

  "business_model_signals": {
    "business_model_type": "",
    "scalability": "",
    "technical_moat": false,
    "automation_potential": "",
    "revenue_model": ""
  },

  "market_signals": {
    "target_customer": "",
    "industry": "",
    "value_proposition": "",
    "competitive_landscape": ""
  },

  "investor_reaction": {
    "investor_interest_level": "",
    "investor_concerns": "",
    "positive_signals": [],
    "negative_signals": []
  },

  "deal_decision": {
    "conviction_score": 0,
    "why_exciting": "",
    "risks": "",
    "reasons_pass": "",
    "reasons_watch": "",
    "action_required": ""
  },

  "supporting_quotes": {
    "technical_moat_concern_quote": "",
    "services_model_quote": "",
    "other_notable_quotes": []
  }
}

Rules:
- All score-like numeric fields must be numbers between 0 and 10 (inclusive).
- If the transcript does not clearly state something, make a reasonable inference or use "" for strings and 0 for scores.
- Dates should be ISO strings (YYYY-MM-DD) when possible or "" if not inferable.
`

  const MAX_ATTEMPTS = 3
  let lastError

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const text = await deepseekChatJson({ systemInstruction, prompt })
      return parseJsonFromModel(text)
    } catch (err) {
      lastError = err
      console.warn(
        `DeepSeek error during deal extraction (attempt ${attempt}/${MAX_ATTEMPTS})`,
        err
      )
      if (attempt < MAX_ATTEMPTS) {
        await delay(1000 * attempt)
      }
    }
  }

  throw lastError ?? new Error('Deal extraction failed after retries')
}

