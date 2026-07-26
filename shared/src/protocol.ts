import { z } from 'zod'
import type { Channel, Message, User } from './types.js'

export const MAX_MESSAGE_LENGTH = 4000

/**
 * Wire-protocol generation. Bump on breaking changes to the shapes in this
 * file; a client that sees a different value in `welcome` prompts a reload
 * (server and web bundle deploy in lockstep, so reloading converges).
 */
export const PROTOCOL_VERSION = 1

/**
 * The channel every deployment starts with: created at boot, receives join
 * announcements, cannot be retired, and is the client's landing channel.
 */
export const HOME_CHANNEL = 'general'

// ---------------------------------------------------------------------------
// Client → server (validated on the server with zod)
// ---------------------------------------------------------------------------

export const helloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  /** channelId → highest seq this client already has. */
  cursors: z.record(z.string(), z.number().int().nonnegative()),
})

// Note: body may be empty when fileId is present (checked in the handler —
// zod discriminated unions can't contain refined schemas).
export const sendSchema = z.object({
  type: z.literal('send'),
  clientMsgId: z.string().min(8).max(64),
  channelId: z.string().min(1),
  body: z.string().max(MAX_MESSAGE_LENGTH).default(''),
  fileId: z.string().min(1).optional(),
})

export const typingSchema = z.object({
  type: z.literal('typing'),
  channelId: z.string().min(1),
})

export const markReadSchema = z.object({
  type: z.literal('markRead'),
  channelId: z.string().min(1),
  seq: z.number().int().nonnegative(),
})

export const createChannelSchema = z.object({
  type: z.literal('createChannel'),
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'lowercase letters, numbers and dashes'),
  topic: z.string().max(200).default(''),
})

export const openDmSchema = z.object({
  type: z.literal('openDm'),
  userId: z.string().min(1),
})

export const pingSchema = z.object({
  type: z.literal('ping'),
  t: z.number(),
})

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  sendSchema,
  typingSchema,
  markReadSchema,
  createChannelSchema,
  openDmSchema,
  pingSchema,
])

export type ClientMessage = z.infer<typeof clientMessageSchema>

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Non-sensitive settings sent to every client (admin-editable subset + info). */
export interface PublicConfig {
  /**
   * What this box is for — "Ashton Court 2026". Shown instead of "Crewbox"
   * on the join screen, the sidebar and the tab title. '' when unset, which
   * is the honest state for a box nobody has set up yet.
   */
  eventName: string
  /** Wi-Fi network name shown as join guidance; '' when unset. */
  wifiSsid: string
  /** Whether the server has a voice (LiveKit) backend configured. */
  voiceEnabled: boolean
  /** Module ids this box enables; clients hide modules not listed here. */
  modules: string[]
}

export interface WelcomeMessage {
  type: 'welcome'
  /** Server build string, so a client on an older build can prompt a reload. */
  serverVersion: string
  /** Wire-protocol generation (PROTOCOL_VERSION); optional: older servers omit. */
  protocolVersion?: number
  /** Live public settings (Wi-Fi SSID, voice availability). */
  config: PublicConfig
  me: User
  users: User[]
  channels: Channel[]
  /** channelId → my last read seq. */
  readState: Record<string, number>
  /** userIds currently connected. */
  online: string[]
  /**
   * userIds connected only from off-site (via the internet tunnel, no LAN
   * socket) — the sidebar shows these as "office" so crew know who is
   * physically around. Optional: older servers omit it.
   */
  remote?: string[]
  /** Messages newer than the client's cursors, ascending by (channel, seq). */
  missed: Message[]
  /** Channels where `missed` was truncated; client should refetch history. */
  truncated: string[]
  /** Recently deleted messages, so returning clients drop stale cache entries. */
  deletions: { channelId: string; messageId: string }[]
}

export interface MsgMessage {
  type: 'msg'
  message: Message
}

/** Ack for a send from this connection; carries the stored message. */
export interface AckMessage {
  type: 'ack'
  clientMsgId: string
  message: Message
}

/** Permanent rejection of a send — the client should drop it from its outbox. */
export interface RejectedMessage {
  type: 'rejected'
  clientMsgId: string
  reason: string
}

export interface PresenceMessage {
  type: 'presence'
  userId: string
  online: boolean
  /** True when every open connection for this user is off-site. */
  remote?: boolean
}

export interface TypingMessage {
  type: 'typing'
  channelId: string
  userId: string
}

export interface UserMessage {
  type: 'user'
  user: User
}

export interface ChannelMessage {
  type: 'channel'
  channel: Channel
}

/** Read-state sync to the same user's other devices. */
export interface ReadStateMessage {
  type: 'readState'
  channelId: string
  seq: number
}

export interface PongMessage {
  type: 'pong'
  t: number
}

/** Live push of updated public settings (e.g. admin changed the Wi-Fi SSID). */
export interface ConfigMessage {
  type: 'config'
  config: PublicConfig
}

/** A message was deleted (e.g. a shared file removed by its author/admin). */
export interface DeletedMessage {
  type: 'deleted'
  channelId: string
  messageId: string
}

export interface ErrorMessage {
  type: 'error'
  code: 'auth' | 'bad_request' | 'not_found' | 'forbidden'
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | MsgMessage
  | AckMessage
  | RejectedMessage
  | PresenceMessage
  | TypingMessage
  | UserMessage
  | ChannelMessage
  | ReadStateMessage
  | PongMessage
  | ConfigMessage
  | DeletedMessage
  | ErrorMessage
