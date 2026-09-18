import test from 'node:test'
import assert from 'node:assert/strict'

test('Drive Shortcut logic: target ID and MIME resolution', () => {
  const file = {
    id: 'shortcut-123',
    name: 'Test Shortcut - Notes by Gemini',
    mimeType: 'application/vnd.google-apps.shortcut',
    shortcutDetails: {
      targetId: 'doc-target-456',
      targetMimeType: 'application/vnd.google-apps.document'
    }
  }

  let targetId = file.id
  let targetMimeType = file.mimeType

  if (file.mimeType === 'application/vnd.google-apps.shortcut' && file.shortcutDetails?.targetId) {
    targetId = file.shortcutDetails.targetId
    targetMimeType = file.shortcutDetails.targetMimeType || 'application/vnd.google-apps.document'
  }

  assert.equal(targetId, 'doc-target-456')
  assert.equal(targetMimeType, 'application/vnd.google-apps.document')
})

test('Drive Shortcut logic: falls back to file ID when shortcutDetails missing', () => {
  const file = {
    id: 'regular-doc-789',
    name: 'Regular Doc - Notes by Gemini',
    mimeType: 'application/vnd.google-apps.document'
  }

  let targetId = file.id
  let targetMimeType = file.mimeType

  if (file.mimeType === 'application/vnd.google-apps.shortcut' && file.shortcutDetails?.targetId) {
    targetId = file.shortcutDetails.targetId
    targetMimeType = file.shortcutDetails.targetMimeType || 'application/vnd.google-apps.document'
  }

  assert.equal(targetId, 'regular-doc-789')
  assert.equal(targetMimeType, 'application/vnd.google-apps.document')
})

test('Drive Shortcut logic: formats 404 target not found diagnostics cleanly', () => {
  const targetId = 'missing-target-001'
  const err = { code: 404, message: 'File not found: missing-target-001.' }
  const isNotFound = err?.code === 404 || err?.status === 404 || /not found/i.test(err?.message || '')
  assert.equal(isNotFound, true)

  const formattedMsg = `shortcut target document (${targetId}) not found or not shared with this Google account: ${err.message}`
  assert.match(formattedMsg, /not found or not shared/)
  assert.match(formattedMsg, /missing-target-001/)
})

test('Drive Lock logic: identifies dead PID worker from locked_by string', () => {
  const lockHolder = 'worker-99999999-1789761237751'
  const match = lockHolder.match(/^worker-(\d+)-/)
  assert.ok(match)
  const holderPid = Number(match[1])
  assert.equal(holderPid, 99999999)

  let isDead = false
  try {
    process.kill(holderPid, 0)
  } catch (e) {
    if (e.code === 'ESRCH') {
      isDead = true
    }
  }
  assert.equal(isDead, true)
})

