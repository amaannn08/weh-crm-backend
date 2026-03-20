import { Router } from 'express'
import jwt from 'jsonwebtoken'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET
const LOGIN_USERNAME = process.env.LOGIN_USERNAME
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD

router.post('/login', (req, res) => {
  if (!JWT_SECRET || !LOGIN_USERNAME || !LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Auth not configured' })
  }
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' })
  }
  if (username !== LOGIN_USERNAME || password !== LOGIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  const token = jwt.sign({ sub: 'user' }, JWT_SECRET, { expiresIn: '24h' })
  return res.json({ token })
})

export default router
