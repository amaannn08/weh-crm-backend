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
