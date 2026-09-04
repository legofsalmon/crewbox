import { z } from 'zod'
import type { Channel, Message, User } from './types.js'
import {
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  MAX_INCIDENT_LENGTH,
  type Incident,
} from './incident.js'

export const MAX_MESSAGE_LENGTH = 4000

/**
 * Max `send` frames one socket may emit per window before being throttled.
 *
 * Shared so the client can pace a reconnect replay under it rather than
 * discovering it the hard way. A human hitting thirty messages in ten
 * seconds is already implausibly fast; a phone flushing an outbox is not a
 * human, and it was being judged as one.
 */
export const SEND_LIMIT = 30
export const SEND_WINDOW_MS = 10_000

/**
 * Gap between replayed outbox entries on reconnect.
 *
 * Two thirds of the limit, not all of it: the crew member whose phone is
 * reconnecting is very often typing while it happens, and their live
 * messages share this socket's allowance. Leaving ten sends of headroom is
 * what stops the replay stealing the message somebody is writing now.
 */
export const OUTBOX_FLUSH_GAP_MS = Math.ceil(SEND_WINDOW_MS / (SEND_LIMIT * (2 / 3)))

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

/**
 * A phone telling the box how far away it feels, for the network audit.
 *
 * The client already measures its own ping/pong round trip to draw the signal
 * bars; this hands the same median to the box once a minute so the audit can
 * say "crew Wi-Fi averages 380 ms in the last 15 minutes" instead of guessing
 * from server-side numbers that only ever look healthy.
 *
 * Purely additive and advisory: the box ignores it when the audit module is
 * off, and an older box that doesn't know the type simply drops it — so this
 * needs no PROTOCOL_VERSION bump. The 60 s cap keeps one bad phone from
 * dragging the average into nonsense.
 */
export const rttReportSchema = z.object({
  type: z.literal('rttReport'),
  ms: z.number().int().min(0).max(60_000),
})

/**
 * A device saying how comms actually sounded to it.
 *
 * Distinct from `rttReport`, which is about the WebSocket and answers "how
 * far away does this phone feel". This is about the audio, and answers the
 * question an audio lead asks instead: was anyone's comms breaking up, and
 * whose. Only the receiving browser can say — its decoder is the only thing
 * that knows how much of the sound it had to invent.
 *
 * `concealedPct` is the one that matters. Loss and jitter describe what the
 * network did; concealment is what the crew heard, and the two come apart
 * every time a jitter buffer quietly absorbs a burst.
 *
 * Additive and advisory, like `rttReport`: an older box drops the type, a
 * box with the audit off ignores it, and nothing here reaches a decision —
 * so no PROTOCOL_VERSION bump. Percentages are bounded by the schema rather
 * than trusted, because they are computed on a device the box does not own.
 */
export const voiceStatsSchema = z.object({
  type: z.literal('voiceStats'),
  lossPct: z.number().min(0).max(100),
  jitterMs: z.number().min(0).max(10_000),
  concealedPct: z.number().min(0).max(100),
})

/**
 * Watch what the lighting network is doing.
 *
 * Universes are named by the client because only the client knows which ones
 * its plot uses — the plot is a Yjs document, and the server has no business
 * parsing one. Naming them also means the box only reports on what somebody
 * is actually looking at.
 *
 * `levels` is opt-in: most of the value (is it arriving, does the patch match)
 * needs no levels at all, and levels are the expensive part.
 */
export const dmxWatchSchema = z.object({
  type: z.literal('dmxWatch'),
  universes: z.array(z.number().int().min(0).max(63999)).max(32),
  levels: z.boolean().default(false),
})

/**
 * File an entry in the show log.
 *
 * `at` is when it happened and is the client's to decide — a stage manager
 * logs at 21:14 the thing that stopped the show at 21:04, and the record has
 * to say 21:04. It is bounded to a day either side of the box's own clock so
 * a wrong phone clock can misplace an entry by hours but never by years.
 */
export const logIncidentSchema = z.object({
  type: z.literal('logIncident'),
  clientMsgId: z.string().min(8).max(64),
  kind: z.enum(INCIDENT_KINDS).default('note'),
  severity: z.enum(INCIDENT_SEVERITIES).default('note'),
  body: z.string().trim().min(1).max(MAX_INCIDENT_LENGTH),
  at: z.number().int().positive(),
  stage: z.string().max(80).default(''),
  actId: z.string().max(64).default(''),
  actName: z.string().max(200).default(''),
  /** The entry this corrects, when it is a correction. */
  amends: z.string().max(64).optional(),
})

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  sendSchema,
  typingSchema,
  markReadSchema,
  createChannelSchema,
  openDmSchema,
  pingSchema,
  dmxWatchSchema,
  rttReportSchema,
  voiceStatsSchema,
  logIncidentSchema,
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
  /**
   * Which database this box is serving.
   *
   * A resume cursor is a bare sequence number, and sequence numbers come from
   * `MAX(seq)` over live rows — so restoring from a backup, or swapping to a
   * spare box, puts the server's counter *below* every phone's cursor. Every
   * channel is then skipped as "nothing new" and nobody notices, because
   * nothing in the welcome said which database it came from. The runbook
   * promises crew phones "reconnect on their own and stay signed in"; they
   * did, and then saw nothing sent on the restored box until its counter
   * climbed past a stale cursor, hours later.
   *
   * A phone that sees this change treats every cursor as zero and drops its
   * cached messages — they are numbered against a database that is no longer
   * there, and two of them at the same seq are two different messages.
   *
   * Optional: a box that predates it simply does not send it, and a client
   * that sees none keeps whatever it had. No PROTOCOL_VERSION bump.
   */
  dbEpoch?: string
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

/** Rejection of a send. Permanent unless `retry` says otherwise. */
export interface RejectedMessage {
  type: 'rejected'
  clientMsgId: string
  reason: string
  /**
   * The box could not take it *now*, and the client should keep it.
   *
   * Only the flood guard sets this, and only it should: everything else that
   * rejects a send is a fact about the message — too long, no such channel,
   * a channel that has been retired — and no amount of waiting changes any of
   * them, so dropping those is right.
   *
   * The guard is different, and the difference cost real messages. A phone
   * that has been out of signal comes back with an outbox, replays it in one
   * go, and the thirty-first frame is refused — by a limit that exists to
   * stop one socket fanning out unbounded traffic, not to say the message
   * was bad. The client deleted every rejection from IndexedDB, so a crew
   * member who typed thirty-five messages in a dead spot got thirty, and the
   * screen that had promised "nothing is lost while this lasts" was wrong.
   *
   * Additive: a box that does not send it, and a client that does not read
   * it, both behave exactly as before. No PROTOCOL_VERSION bump.
   */
  retry?: true
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
  /**
   * `auth` means *this session is no longer valid* — the client should stop
   * using its token. It is the only code that ends somebody's session, which
   * is why "you have not said hello on this socket yet" is `handshake` and
   * not this: that is a fact about one connection, and a box under load or
   * short of disk could produce it with the session perfectly intact. It did,
   * and every phone on site was signed out.
   *
   * Additive: a client that does not know `handshake` falls through to its
   * generic branch and shows the message, which is wrong but survivable —
   * unlike logging out. No PROTOCOL_VERSION bump.
   */
  code: 'auth' | 'handshake' | 'bad_request' | 'not_found' | 'forbidden'
  message: string
}

/** One universe as a watching client sees it. */
export interface DmxUniverseWire {
  /** Plot-space universe. */
  universe: number
  /** What was on the wire — Art-Net counts from 0, so these can differ. */
  wireUniverse: number
  protocol: 'artnet' | 'sacn'
  /** The source being believed, '' when nothing is arriving. */
  source: string
  sources: number
  /** Two or more sources at the top priority; nobody can say who wins. */
  conflict: boolean
  /**
   * Whether these levels are on stage.
   *
   * `none` is the ordinary case. `held` means a receiver is queueing them
   * until the next synchronization packet. `frozen` means the sync stream
   * died and receivers are stuck on their last look while the desk keeps
   * sending — the fault this exists to catch. `lost` is the same failure
   * where the source allowed receivers to carry on regardless. `unwatched`
   * means the sync universe isn't one this box joined, so it can't tell.
   * `unsynchronised` means nothing has *ever* arrived on that sync
   * universe: the stage is following the desk (§6.2.4.1), but the
   * multi-universe timing the source asked for is not happening at all.
   *
   * See `DmxSyncState` in the server for the clauses behind each.
   */
  sync: 'none' | 'held' | 'frozen' | 'lost' | 'unwatched' | 'unsynchronised'
  /** The universe synchronization packets are expected on, or 0. */
  syncAddress: number
  /** When this universe was first heard — the window the verdicts speak for. */
  since: number
  lastSeen: number
  /**
   * 64 bytes, base64: one bit per address, set once that address has been
   * above zero. The client turns this into a per-fixture verdict, because
   * only the client knows where its fixtures are addressed.
   */
  everLit: string
}

/**
 * Who is live on camera, if anybody.
 *
 * Raised from a vision desk through the control API, not by anyone in the
 * app — the person on camera is the last person who should be looking at a
 * phone to find out. Sent to every device, because "don't call Dev, he's
 * live" is as useful to the caller as the red bar is to Dev.
 *
 * `userId` null means nobody is on air, which is a state worth broadcasting
 * rather than an absence worth inferring.
 */
export interface TallyMessage {
  type: 'tally'
  userId: string | null
  /** When it went live, so a device joining late can show how long. 0 when off. */
  since: number
}

export interface DmxStateMessage {
  type: 'dmxState'
  /** False when this box was never asked to listen to a lighting network. */
  listening: boolean
  universes: DmxUniverseWire[]
}

export interface DmxLevelsMessage {
  type: 'dmxLevels'
  universe: number
  /** True when this is a whole-universe snapshot rather than a change. */
  full: boolean
  /** [address, level] pairs. Addresses are 1-based, levels 0–255. */
  values: Array<[number, number]>
}

/**
 * A new show-log entry, to every connected client.
 *
 * Broadcast rather than fetched, because the value of the log is that the
 * whole crew sees the same account of the night as it is written — a lighting
 * tech who watched the same thing happen can file the correction before
 * anyone has gone home.
 */
export interface IncidentMessage {
  type: 'incident'
  incident: Incident
}

export type ServerMessage =
  | IncidentMessage
  | TallyMessage
  | WelcomeMessage
  | DmxStateMessage
  | DmxLevelsMessage
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
