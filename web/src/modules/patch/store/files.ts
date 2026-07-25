import type { ArtistFile } from '../model/types'
import * as api from '../../../lib/api.ts'
import { apiUrl } from '../../../lib/server.ts'
import { sessionToken, useStore } from '../../../store.ts'

/**
 * Artist attachments go through the crewbox files service — the same
 * content-addressed store chat attachments use (sha-256 dedupe, capability
 * URLs, immutable caching) — not a module-private endpoint. Removing a file
 * from a sheet only drops the doc's reference; the blob stays on the box
 * (content-addressed and shared, exactly like a chat upload whose message
 * was edited away).
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export const canUseAttachments = (): boolean =>
  Boolean(sessionToken()) && useStore.getState().connection === 'online'

/** Download/view URL for a stored attachment (capability URL — no headers). */
export const attachmentUrl = (file: ArtistFile): string =>
  apiUrl(`/api/files/${file.id}/${encodeURIComponent(file.name)}`)

/** Upload a file's bytes; returns the metadata to store in the doc. */
export const uploadAttachment = async (file: File): Promise<ArtistFile> => {
  const { file: meta } = await api.uploadFile(sessionToken() ?? '', file)
  return { id: meta.id, name: meta.name, type: meta.mime, size: meta.size }
}
