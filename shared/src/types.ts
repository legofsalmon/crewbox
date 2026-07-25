export type Role = 'admin' | 'member'

export interface User {
  id: string
  name: string
  role: Role
  createdAt: number
}

export type ChannelKind = 'public' | 'dm'

export interface Channel {
  id: string
  name: string
  kind: ChannelKind
  topic: string
  /** Highest message seq in the channel; unread = lastSeq - readState. */
  lastSeq: number
  /** Only present for DMs: the two participant user ids. */
  memberIds?: string[]
  /** Retired by an admin: hidden from sidebars, rejects new messages. */
  retired?: boolean
  createdAt: number
}

export type MessageKind = 'text' | 'system' | 'file'

export interface FileMeta {
  id: string
  name: string
  mime: string
  size: number
  /** Pixel dimensions, captured at upload (images only). */
  width?: number
  height?: number
  /** A small JPEG preview is available at thumbUrl(). */
  hasThumb?: boolean
}

export interface Message {
  id: string
  channelId: string
  /** Server-assigned, monotonically increasing per channel. */
  seq: number
  /** null for system messages. */
  authorId: string | null
  kind: MessageKind
  body: string
  /** Attached upload (kind === 'file'). */
  file?: FileMeta
  /** Present on messages that originated from a client send (for dedupe). */
  clientMsgId?: string
  createdAt: number
}

/** Download/view URL for an uploaded file. */
export function fileUrl(file: FileMeta): string {
  return `/api/files/${file.id}/${encodeURIComponent(file.name)}`
}

/** Preview URL for an image upload (valid when hasThumb). */
export function thumbUrl(file: FileMeta): string {
  return `/api/files/${file.id}/thumb`
}
