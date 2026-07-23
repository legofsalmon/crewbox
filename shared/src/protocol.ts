import { z } from 'zod'
import type { Channel, Message, User } from './types.js'

export const MAX_MESSAGE_LENGTH = 4000

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
  /** Wi-Fi network name shown as join guidance; '' when unset. */
  wifiSsid: string
  /** Whether the server has a voice (LiveKit) backend configured. */
  voiceEnabled: boolean
}

export interface WelcomeMessage {
  type: 'welcome'
  /** Server build string, so a client on an older build can prompt a reload. */
  serverVersion: string
  /** Live public settings (Wi-Fi SSID, voice availability). */
  config: PublicConfig
  me: User
  users: User[]
  channels: Channel[]
  /** channelId → my last read seq. */
  readState: Record<string, number>
  /** userIds currently connected. */
  online: string[]
  /** Messages newer than the client's cursors, ascending by (channel, seq). */
  missed: Message[]
  /** Channels where `missed` was truncated; client should refetch history. */
  truncated: string[]
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
  | ErrorMessage
