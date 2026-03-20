import { GoogleGenAI } from '@google/genai'
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const MODEL = 'gemini-embedding-001'
const DIMENSIONS = 1536

export async function embed(text) {
  if (!text || !text.trim()) {
    throw new Error('embed() requires non-empty text')
  }
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
}
