import { GoogleGenAI } from '@google/genai'
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const MODEL = 'gemini-embedding-001'
const DIMENSIONS = 1536

export async function embed(text, maxRetries = 3) {
  if (!text || !text.trim()) {
    throw new Error('embed() requires non-empty text')
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      const isRateLimit = err?.status === 429 || err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED')
      if (isRateLimit && attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt + 1) * 2000
        console.warn(`[embeddings] Gemini API 429 rate limit hit. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`)
        await new Promise((res) => setTimeout(res, delayMs))
        continue
      }
      throw err
    }
  }
}
