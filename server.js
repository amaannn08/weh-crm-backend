import 'dotenv/config'
import express from 'express'
import { join } from 'path'
import authRoutes from './routes/auth.js'
import assistantRoutes from './routes/assistant.js'
import conversationRoutes from './routes/conversations.js'
import dealsRoutes from './routes/deals.js'
import meetingsRoutes from './routes/meetings.js'
import { authMiddleware } from './middleware/auth.js'
import { initSchema } from './db/neon.js'

const app = express()
const PORT = process.env.PORT ?? 3000

initSchema()
  .then(() => console.log('Schema init: OK'))
  .catch((err) => {
    console.error('Schema init error:', err)
  })

app.use(express.json())
app.get('/health', (req, res) => res.send('ok'));
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN ?? '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

app.use(
  '/uploads/deal-files',
  express.static(join(process.cwd(), 'uploads', 'deal-files'))
)

app.use('/auth', authRoutes)
app.use('/assistant', authMiddleware, assistantRoutes)
app.use('/conversations', authMiddleware, conversationRoutes)
app.use('/deals', authMiddleware, dealsRoutes)
app.use('/meetings', authMiddleware, meetingsRoutes)

app.listen(PORT,'0.0.0.0', () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
