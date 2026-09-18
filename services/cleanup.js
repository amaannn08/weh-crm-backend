import { existsSync, statSync, unlinkSync, readdirSync } from 'fs'
import { resolve, relative, join, isAbsolute } from 'path'

// Allowed directories where document/temp files may be safely deleted.
// uploads/deal-files is explicitly EXCLUDED to protect active deal attachments.
const ALLOWED_CLEANUP_DIRS = [
  resolve(process.cwd(), 'uploads', 'transcripts-tmp'),
  resolve(process.cwd(), process.env.TRANSCRIPTS_DIR || 'docs'),
  resolve(process.cwd(), 'docs')
]

/**
 * Validates that a target file path resides strictly inside one of the allowed directories.
 * Prevents path traversal and accidental deletion of outside assets.
 */
export function isPathAllowedForCleanup(filePath, allowedDirs = ALLOWED_CLEANUP_DIRS) {
  if (!filePath) return false
  const target = resolve(filePath)

  return allowedDirs.some((dir) => {
    const resolvedDir = resolve(dir)
    const rel = relative(resolvedDir, target)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/**
 * Safely removes a file from disk with strict path containment checks.
 *
 * @param {string} filePath - Absolute or relative file path to delete
 * @param {string[]} [customAllowedDirs] - Optional custom allowed parent directories
 * @returns {{ deleted: boolean, bytesFreed: number, path: string, reason?: string }}
 */
export function safeUnlink(filePath, customAllowedDirs = null) {
  if (!filePath) {
    return { deleted: false, bytesFreed: 0, path: '', reason: 'empty_path' }
  }

  const resolved = resolve(filePath)
  const allowedDirs = customAllowedDirs
    ? (Array.isArray(customAllowedDirs) ? customAllowedDirs.map((d) => resolve(d)) : [resolve(customAllowedDirs)])
    : ALLOWED_CLEANUP_DIRS

  if (!isPathAllowedForCleanup(resolved, allowedDirs)) {
    const err = `[cleanup] Refusing to delete ${resolved}: path is not in allowed cleanup directories`
    console.warn(err)
    return { deleted: false, bytesFreed: 0, path: resolved, reason: 'disallowed_directory' }
  }

  if (!existsSync(resolved)) {
    return { deleted: false, bytesFreed: 0, path: resolved, reason: 'not_found' }
  }

  try {
    const stats = statSync(resolved)
    const bytes = stats.size || 0
    unlinkSync(resolved)
    console.log(`[cleanup] Removed ${resolved} (${bytes} bytes freed)`)
    return { deleted: true, bytesFreed: bytes, path: resolved }
  } catch (err) {
    console.warn(`[cleanup] Failed to unlink ${resolved}:`, err.message)
    return { deleted: false, bytesFreed: 0, path: resolved, reason: err.message }
  }
}

/**
 * Sweeps uploads/transcripts-tmp to clean orphaned temporary transcript docx files
 * older than maxAgeMs (default: 1 hour).
 *
 * @param {number} [maxAgeMs=3600000] - Age threshold in milliseconds
 * @returns {{ filesChecked: number, filesDeleted: number, bytesFreed: number }}
 */
export function cleanOrphanedTranscripts(maxAgeMs = 3600000) {
  const tmpDir = resolve(process.cwd(), 'uploads', 'transcripts-tmp')
  if (!existsSync(tmpDir)) {
    return { filesChecked: 0, filesDeleted: 0, bytesFreed: 0 }
  }

  let filesChecked = 0
  let filesDeleted = 0
  let bytesFreed = 0

  const now = Date.now()
  let entries = []
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true })
  } catch (err) {
    console.warn('[cleanup] Could not read transcripts-tmp directory:', err.message)
    return { filesChecked, filesDeleted, bytesFreed }
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    filesChecked++
    const fullPath = join(tmpDir, entry.name)

    try {
      const stats = statSync(fullPath)
      const ageMs = now - stats.mtimeMs
      if (ageMs > maxAgeMs) {
        const res = safeUnlink(fullPath, [tmpDir])
        if (res.deleted) {
          filesDeleted++
          bytesFreed += res.bytesFreed
        }
      }
    } catch {
      // Ignore race conditions where file was already deleted
    }
  }

  if (filesDeleted > 0) {
    console.log(
      `[cleanup] Orphaned transcripts sweep complete: ${filesDeleted} file(s) removed, ${bytesFreed} bytes freed`
    )
  }

  return { filesChecked, filesDeleted, bytesFreed }
}
