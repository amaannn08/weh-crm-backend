import { Router } from 'express'
import { sql } from '../db/neon.js'

const router = Router()

router.get('/', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT id, title, created_at
      FROM conversations
      ORDER BY created_at DESC
    `
    return res.json(rows.map((r) => ({ id: r.id, title: r.title ?? 'New session', created_at: r.created_at })))
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to list conversations' })
  }
})

router.post('/', async (req, res) => {
  try {
    const title = req.body?.title ?? 'New session'
    const [row] = await sql`
      INSERT INTO conversations (title)
      VALUES (${title})
      RETURNING id, title, created_at
    `
    return res.status(201).json({ id: row.id, title: row.title ?? 'New session', created_at: row.created_at })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to create conversation' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id
    const [conv] = await sql`
      SELECT id, title, created_at FROM conversations WHERE id = ${id}::uuid
    `
    if (!conv) return res.status(404).json({ error: 'Conversation not found' })
    const messages = await sql`
      SELECT role, content, created_at
      FROM conversation_messages
      WHERE conversation_id = ${id}::uuid
      ORDER BY created_at ASC
    `
    return res.json({
      id: conv.id,
      title: conv.title ?? 'New session',
      created_at: conv.created_at,
      messages: messages.map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }))
    })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to get conversation' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id
    const existing = await sql`
      SELECT id FROM conversations WHERE id = ${id}::uuid
    `
    if (!existing.length) {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    await sql`
      DELETE FROM conversations WHERE id = ${id}::uuid
    `
    return res.status(204).end()
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to delete conversation' })
  }
})

export default router
