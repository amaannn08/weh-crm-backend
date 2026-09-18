import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import {
  isPathAllowedForCleanup,
  safeUnlink,
  cleanOrphanedTranscripts
} from '../services/cleanup.js'

test('Cleanup: isPathAllowedForCleanup', () => {
  const tmpAllowed = resolve(process.cwd(), 'uploads', 'transcripts-tmp')
  const insideTmp = join(tmpAllowed, 'sample.docx')
  assert.equal(isPathAllowedForCleanup(insideTmp), true)

  const outsideDealFiles = resolve(process.cwd(), 'uploads', 'deal-files', 'permanent.pdf')
  assert.equal(isPathAllowedForCleanup(outsideDealFiles), false)

  const outsideRoot = resolve('/etc/passwd')
  assert.equal(isPathAllowedForCleanup(outsideRoot), false)

  const parentTraversal = join(tmpAllowed, '..', 'deal-files', 'hack.txt')
  assert.equal(isPathAllowedForCleanup(parentTraversal), false)
})

test('Cleanup: safeUnlink deletes allowed files and reports bytes freed', () => {
  const tmpDir = resolve(process.cwd(), 'uploads', 'transcripts-tmp')
  mkdirSync(tmpDir, { recursive: true })

  const testFile = join(tmpDir, `test-${Date.now()}.docx`)
  const content = 'Test transcript content for cleanup verification'
  writeFileSync(testFile, content)

  assert.equal(existsSync(testFile), true)
  const result = safeUnlink(testFile, [tmpDir])

  assert.equal(result.deleted, true)
  assert.equal(result.bytesFreed, Buffer.byteLength(content))
  assert.equal(existsSync(testFile), false)
})

test('Cleanup: safeUnlink rejects files outside allowed directories', () => {
  const serverFile = resolve(process.cwd(), 'server.js')
  assert.equal(existsSync(serverFile), true)

  const result = safeUnlink(serverFile)
  assert.equal(result.deleted, false)
  assert.equal(result.reason, 'disallowed_directory')
  assert.equal(existsSync(serverFile), true)
})

test('Cleanup: cleanOrphanedTranscripts only cleans expired files', async () => {
  const tmpDir = resolve(process.cwd(), 'uploads', 'transcripts-tmp')
  mkdirSync(tmpDir, { recursive: true })

  const file1 = join(tmpDir, `recent-${Date.now()}.docx`)
  writeFileSync(file1, 'fresh file')

  // Calling cleanOrphanedTranscripts with 1-hour threshold should NOT delete fresh file
  const sweepRecent = cleanOrphanedTranscripts(3600000)
  assert.equal(existsSync(file1), true)

  // Calling cleanOrphanedTranscripts with 0ms threshold should delete it
  const sweepExpired = cleanOrphanedTranscripts(-1)
  assert.equal(sweepExpired.filesDeleted >= 1, true)
  assert.equal(existsSync(file1), false)
})
