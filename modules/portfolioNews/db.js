import { poolRef } from '../../db/neon.js'

export async function query(text, params) {
  return poolRef.query(text, params)
}

export async function getClient() {
  return poolRef.connect()
}
