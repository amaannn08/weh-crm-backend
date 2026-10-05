import { put, del } from '@vercel/blob'
import { join } from 'path'
import { writeFileSync, unlink, mkdirSync, existsSync } from 'fs'

const uploadDir = join(process.cwd(), 'uploads', 'deal-files')

/**
 * Checks whether Vercel Blob storage token is configured.
 */
export function isVercelBlobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

/**
 * Uploads a deal attachment file.
 * Uses Vercel Blob if BLOB_READ_WRITE_TOKEN is set in the environment.
 * Otherwise falls back to local disk (uploads/deal-files) with a warning.
 *
 * @param {Object} file - Multer file object (with buffer, originalname, mimetype)
 * @returns {Promise<string>} Stored path (public CDN URL for Vercel Blob, or filename for local disk)
 */
export async function uploadDealFile(file) {
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
  const timestamp = Date.now()

  if (isVercelBlobConfigured()) {
    try {
      const pathname = `deal-files/${timestamp}-${safeName}`
      const blob = await put(pathname, file.buffer, {
        access: 'public',
        token: process.env.BLOB_READ_WRITE_TOKEN,
        contentType: file.mimetype || undefined
      })
      console.log(`[storage] Successfully uploaded ${file.originalname} to Vercel Blob: ${blob.url}`)
      return blob.url
    } catch (err) {
      console.error('[storage] Failed to upload to Vercel Blob, falling back to local disk:', err)
      // Fall back to local disk below
    }
  } else {
    console.warn('[storage] BLOB_READ_WRITE_TOKEN is not configured. Storing file on local disk (Warning: Render disk is ephemeral!).')
  }

  // Local fallback
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true })
  }
  const filename = `${timestamp}-${safeName}`
  const fullPath = join(uploadDir, filename)
  writeFileSync(fullPath, file.buffer)
  return filename
}

/**
 * Deletes a deal attachment file.
 * If storedPath is a remote URL (starts with http/https), deletes from Vercel Blob.
 * Otherwise unlinks from local disk.
 *
 * @param {string} storedPath
 */
export async function deleteDealFile(storedPath) {
  if (!storedPath) return

  if (storedPath.startsWith('http://') || storedPath.startsWith('https://')) {
    if (isVercelBlobConfigured()) {
      try {
        await del(storedPath, { token: process.env.BLOB_READ_WRITE_TOKEN })
        console.log(`[storage] Deleted from Vercel Blob: ${storedPath}`)
      } catch (err) {
        console.warn('[storage] Failed to delete from Vercel Blob:', err.message)
      }
    }
    return
  }

  // Local file delete
  const fullPath = join(uploadDir, storedPath)
  unlink(fullPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[storage] Failed to remove local file ${fullPath}:`, err.message)
    }
  })
}
