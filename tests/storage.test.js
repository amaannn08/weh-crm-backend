import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { existsSync } from 'fs'
import {
  isVercelBlobConfigured,
  uploadDealFile,
  deleteDealFile
} from '../services/storage.js'

test('Storage: isVercelBlobConfigured detects token presence', () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.BLOB_READ_WRITE_TOKEN
  assert.equal(isVercelBlobConfigured(), false)

  process.env.BLOB_READ_WRITE_TOKEN = 'test_token'
  assert.equal(isVercelBlobConfigured(), true)

  if (originalToken) {
    process.env.BLOB_READ_WRITE_TOKEN = originalToken
  } else {
    delete process.env.BLOB_READ_WRITE_TOKEN
  }
})

test('Storage: uploadDealFile and deleteDealFile fallback to local disk when token is absent', async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.BLOB_READ_WRITE_TOKEN

  const fakeFile = {
    originalname: 'pitch-deck.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('PDF content mock')
  }

  const storedPath = await uploadDealFile(fakeFile)
  assert.ok(storedPath, 'Stored path should be returned')
  assert.ok(storedPath.includes('pitch-deck.pdf'), 'Stored path should contain filename')
  assert.equal(storedPath.startsWith('http'), false, 'Should be a local filename')

  const fullPath = join(process.cwd(), 'uploads', 'deal-files', storedPath)
  assert.equal(existsSync(fullPath), true, 'File should exist on local disk')

  // Clean up
  await deleteDealFile(storedPath)
  // Give unlink callback a tick to finish
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(existsSync(fullPath), false, 'File should be removed by deleteDealFile')

  if (originalToken) {
    process.env.BLOB_READ_WRITE_TOKEN = originalToken
  }
})
