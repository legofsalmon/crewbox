/** Pure helpers for presenting shared files (size, category, friendly label). */

export type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'text' | 'other'

export interface ImageUploadExtras {
  width: number
  height: number
  /** Small JPEG preview; null when the original is already small. */
  thumb: Blob | null
}

/** Longest edge of the preview the uploading client renders. */
const THUMB_MAX_EDGE_PX = 1000
const THUMB_JPEG_QUALITY = 0.82

/**
 * Measure an image and render a small preview before upload, so the message
 * list can reserve layout (no scroll jumps) and old phones never decode a
 * 12-megapixel photo just to draw a 400px bubble. Returns null for
 * non-images and formats this browser can't decode (e.g. HEIC) — the upload
 * then proceeds exactly as before.
 */
export async function measureImage(file: File): Promise<ImageUploadExtras | null> {
  if (!file.type.startsWith('image/')) return null
  try {
    // 'from-image' applies EXIF orientation, so width/height and the drawn
    // thumbnail match what the <img> tag paints. Without it a rotated phone
    // photo yields raw (sideways) pixel dims → a transposed reserved box and
    // a sideways thumbnail, inconsistent between WKWebView and Chromium.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { width, height } = bitmap
    let thumb: Blob | null = null
    const longest = Math.max(width, height)
    if (longest > THUMB_MAX_EDGE_PX) {
      const scale = THUMB_MAX_EDGE_PX / longest
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        thumb = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', THUMB_JPEG_QUALITY)
        )
      }
    }
    bitmap.close()
    return width > 0 && height > 0 ? { width, height, thumb } : null
  } catch {
    return null
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
  'application/x-tar',
])

export function fileCategory(mime: string): FileCategory {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (ARCHIVE_MIMES.has(mime)) return 'archive'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') return 'text'
  return 'other'
}

/** "Image · PNG", "PDF document", "ZIP archive" — friendly but honest. */
export function describeFile(mime: string): string {
  const category = fileCategory(mime)
  const subtype = (mime.split('/')[1] ?? '').split('+')[0]
  const upper = subtype.toUpperCase()
  switch (category) {
    case 'image':
      return subtype ? `Image · ${upper}` : 'Image'
    case 'video':
      return subtype ? `Video · ${upper}` : 'Video'
    case 'audio':
      return subtype ? `Audio · ${upper}` : 'Audio'
    case 'pdf':
      return 'PDF document'
    case 'archive':
      return subtype.includes('zip') || subtype.includes('7z') || subtype.includes('rar')
        ? `${upper.replace('X-', '').replace('-COMPRESSED', '')} archive`
        : 'Archive'
    case 'text':
      return mime === 'application/json' ? 'JSON file' : subtype ? `Text · ${upper}` : 'Text file'
    default:
      return mime || 'File'
  }
}
