import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const MODEL = 'gemini-embedding-001'
const DIMENSIONS = 1536

// Free tier: 100 RPM, 1,000 RPD.
// 1s between calls keeps us at ~60 RPM — safely under the limit.
// Configurable via EMBED_DELAY_MS env var (default: 1000ms).
const EMBED_DELAY_MS = Number(process.env.EMBED_DELAY_MS ?? 1000)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function embedWithRetry(text, attempt = 1, maxAttempts = 5) {
  try {
    const response = await ai.models.embedContent({
      model: MODEL,
      contents: text.trim(),
      config: { outputDimensionality: DIMENSIONS }
    })
    const embedding = response.embeddings?.[0]?.values
    if (!embedding || embedding.length !== DIMENSIONS) {
      throw new Error(`Unexpected embedding shape: ${embedding?.length ?? 0}`)
    }
    return embedding
  } catch (err) {
    const is429 =
      err?.status === 429 ||
      err?.code === 429 ||
      String(err?.message ?? '').includes('RESOURCE_EXHAUSTED') ||
      String(err?.message ?? '').includes('429')

    if (is429 && attempt < maxAttempts) {
      // Start at 60s so the per-minute quota window refills before we retry.
      const delayMs = Math.min(60_000 * Math.pow(2, attempt - 1), 120_000)
      console.warn(
        `[embed] Rate limited (429). Waiting ${delayMs / 1000}s before retry ` +
        `(attempt ${attempt}/${maxAttempts})`
      )
      await sleep(delayMs)
      return embedWithRetry(text, attempt + 1, maxAttempts)
    }
    throw err
  }
}

export async function embed(text) {
  if (!text || !text.trim()) {
    throw new Error('embed() requires non-empty text')
  }
  // Throttle: wait between consecutive calls to stay under 100 RPM free tier limit
  if (EMBED_DELAY_MS > 0) {
    await sleep(EMBED_DELAY_MS)
  }
  return embedWithRetry(text)
}
