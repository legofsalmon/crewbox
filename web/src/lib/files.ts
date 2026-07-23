/** Pure helpers for presenting shared files (size, category, friendly label). */

export type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'text' | 'other'

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
