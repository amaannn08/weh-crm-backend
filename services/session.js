import { sql } from '../db/neon.js'

const MAX_HISTORY = 20

export async function createSession({ conversationId, userMessage }) {
  let conversationIdToUse = conversationId ? String(conversationId).trim() || null : null
  let conversationTitle = 'New session'

  if (conversationIdToUse) {
    const [conv] = await sql`
      SELECT title FROM conversations WHERE id = ${conversationIdToUse}::uuid
    `
    if (!conv) {
      const error = new Error('Conversation not found')
      error.code = 'CONVERSATION_NOT_FOUND'
      throw error
    }
    conversationTitle = conv.title ?? 'New chat'
  } else {
    const [inserted] = await sql`
      INSERT INTO conversations (title) VALUES ('New session')
      RETURNING id, title
    `
    conversationIdToUse = inserted.id
    conversationTitle = inserted.title ?? 'New session'
  }

  const historyRows = await sql`
    SELECT role, content, created_at
    FROM conversation_messages
    WHERE conversation_id = ${conversationIdToUse}::uuid
    ORDER BY created_at ASC
    LIMIT ${MAX_HISTORY * 2}
  `

  const conversationHistory = historyRows.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    createdAt: m.created_at
  }))

  const session = {
    id: conversationIdToUse,
    conversationId: conversationIdToUse,
    conversationTitle,
    conversation_history: conversationHistory,
    memory: {},
    tools_available: [],
    toolResults: {}
  }

  const historyBlob = conversationHistory
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  return { session, conversationTitle, historyBlob }
}

export function appendToHistory(session, role, content) {
  if (!session || !session.conversation_history) return
  session.conversation_history.push({
    role,
    content,
    createdAt: new Date()
  })
}

