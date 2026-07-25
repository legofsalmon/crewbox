import type { ArtistFile } from '../model/types'
import { syncManager } from './sync'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** The relay's HTTP base URL derived from the websocket URL, or '' when unset. */
export const relayHttpBase = (): string => {
  const { url } = syncManager.getSettings()
  if (!url) return ''
  return url.replace(/^ws/i, 'http').replace(/\/+$/, '')
}

const tokenQuery = (): string => {
  const { token } = syncManager.getSettings()
  return token ? `?token=${encodeURIComponent(token)}` : ''
}

export const canUseAttachments = (): boolean =>
  relayHttpBase() !== '' && syncManager.status() === 'connected'

/** Download/view URL for a stored attachment. */
export const attachmentUrl = (fileId: string): string =>
  `${relayHttpBase()}/files/${fileId}${tokenQuery()}`

/** Upload a file's bytes to the relay; returns the metadata to store in the doc. */
export const uploadAttachment = async (file: File): Promise<ArtistFile> => {
  const id = crypto.randomUUID()
  const response = await fetch(`${relayHttpBase()}/files/${id}${tokenQuery()}`, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  })
  if (!response.ok) throw new Error(`Upload failed (${response.status})`)
  return { id, name: file.name, type: file.type, size: file.size }
}

/** Best-effort removal of the stored bytes; doc metadata is removed separately. */
export const deleteAttachment = async (fileId: string): Promise<void> => {
  try {
    await fetch(`${relayHttpBase()}/files/${fileId}${tokenQuery()}`, { method: 'DELETE' })
  } catch {
    // The reference is already gone from the doc; orphaned bytes are harmless.
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
