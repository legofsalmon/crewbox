import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { newId, type PublicConfig, type User } from '@inter/shared'
import { APP_VERSION } from './version.ts'
import { hashPin, newToken, RateLimiter, verifyPin } from './auth.ts'
import { Hub } from './hub.ts'
import type { Store } from './store.ts'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const joinBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[\p{L}\p{N} ()._'-]+$/u, 'letters, numbers, spaces and ()._\'- only'),
  eventPin: z.string().max(64).default(''),
  personalPin: z.string().regex(/^\d{4,8}$/, '4–8 digits'),
})

const historyQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const resetPinBodySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, '4–8 digits'),
})

const channelPatchSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'lowercase letters, numbers and dashes')
    .optional(),
  topic: z.string().max(200).optional(),
  retired: z.boolean().optional(),
})

const settingsPatchSchema = z.object({
  wifiSsid: z.string().trim().max(64).optional(),
})

/**
 * Parse a single-range `Range: bytes=…` header. Returns the inclusive byte
 * window, 'unsatisfiable' (→ 416), or null to serve the whole file (absent,
 * malformed or multi-range headers all fall back to a plain 200).
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null // malformed or multi-range
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return null
  if (startStr === '') {
    // Suffix form: last N bytes.
    const suffix = Number(endStr)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startStr)
  if (start >= size) return 'unsatisfiable'
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

export interface AppDeps {
  store: Store
  eventPin: string
  /** Initial Wi-Fi SSID default; admin can override at runtime (settings table). */
  wifiSsid?: string
  /** Directory for uploaded files; omit to disable uploads (tests). */
  filesDir?: string
  /** LiveKit connection details; omit to disable voice. */
  livekit?: { url: string; key: string; secret: string }
  logger?: boolean
}

export type App = FastifyInstance & { hub: Hub }

export function buildApp({
  store,
  eventPin,
  wifiSsid = '',
  filesDir,
  livekit,
  logger = true,
}: AppDeps): App {
  const fastify = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    // Open WebSockets must never block shutdown — restarts have to be instant
    // and unattended on the festival box.
    forceCloseConnections: true,
  })

  // Effective public settings: DB override wins over the deploy-time default.
  const publicConfig = (): PublicConfig => ({
    wifiSsid: store.getSetting('wifiSsid') ?? wifiSsid,
    voiceEnabled: Boolean(livekit?.url),
  })

  const hub = new Hub(store, fastify.log, publicConfig)
  // Per-IP: every phone has its own LAN IP, so 10/min only throttles
  // PIN-guessing, not a crew rush after a briefing.
  const joinLimiter = new RateLimiter(Number(process.env.JOIN_RATE_LIMIT ?? 10), 60_000)
  if (filesDir) mkdirSync(filesDir, { recursive: true })
  // Native wrappers load the bundle from the app package, so their requests
  // are cross-origin. Auth is bearer-token (no cookies), so open CORS adds
  // no CSRF surface on the crew LAN.
  void fastify.register(cors, { origin: true })
  void fastify.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })

  const authUser = (req: FastifyRequest): User | undefined => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return undefined
    return store.getSessionUser(header.slice('Bearer '.length))
  }

  fastify.get('/api/health', () => ({
    ok: true,
    version: APP_VERSION,
    uptime: process.uptime(),
    ...hub.stats(),
  }))

  // Public settings the pre-auth join screen and offline screen need.
  fastify.get('/api/config', () => publicConfig())

  // Join doubles as login: a known name + matching personal PIN gets a new
  // session; an unknown name + correct event PIN creates the user.
  fastify.post('/api/join', (req, reply) => {
    if (!joinLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: 'Too many attempts — wait a minute and try again' })
    }
    const parsed = joinBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    const { name, eventPin: suppliedEventPin, personalPin } = parsed.data

    const existing = store.getUserByName(name)
    if (existing) {
      if (!verifyPin(personalPin, existing.pinHash)) {
        return reply
          .code(401)
          .send({ error: 'That name is taken and the PIN doesn\'t match. Pick another name, or use your PIN.' })
      }
      const token = newToken()
      store.createSession(token, existing.id)
      const { pinHash: _, ...user } = existing
      return { token, user, created: false }
    }

    if (suppliedEventPin !== eventPin) {
      return reply.code(401).send({ error: 'Wrong event PIN — check the join poster' })
    }
    const role = store.countUsers() === 0 ? 'admin' : 'member'
    const user = store.createUser(name, hashPin(personalPin), role)
    const token = newToken()
    store.createSession(token, user.id)

    hub.announceUser(user)
    const general = store.getChannelByName('general')
    if (general) hub.systemMessage(general.id, `${user.name} joined`)

    return { token, user, created: true }
  })

  fastify.get('/api/me', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    return { user }
  })

  // Upload a file; returns metadata to reference in a `send`. Identical
  // content is stored once (sha256 dedupe) under a fresh file id.
  fastify.post('/api/files', async (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    if (!filesDir) return reply.code(503).send({ error: 'uploads disabled' })
    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'no file' })

    const tmpPath = join(filesDir, `tmp-${newId()}`)
    const hash = createHash('sha256')
    part.file.on('data', (chunk: Buffer) => hash.update(chunk))
    await pipeline(part.file, createWriteStream(tmpPath))
    if (part.file.truncated) {
      await unlink(tmpPath)
      return reply.code(413).send({ error: 'file too large' })
    }

    const sha256 = hash.digest('hex')
    const { size } = await stat(tmpPath)
    const existingPath = store.findPathBySha(sha256)
    let path: string
    if (existingPath) {
      await unlink(tmpPath)
      path = existingPath
    } else {
      path = join(filesDir, sha256)
      await rename(tmpPath, path)
    }
    const name = (part.filename || 'file').slice(0, 200)
    const file = store.createFile({
      name,
      mime: part.mimetype || 'application/octet-stream',
      size,
      sha256,
      path,
    })
    return { file }
  })

  // Files are addressed by unguessable ids (capability URLs) so <img> tags
  // work without auth headers on the crew LAN. Single-range requests are
  // honoured (206) — iOS Safari refuses to play video/audio without them.
  fastify.get('/api/files/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string; name: string }
    const row = store.getFileRow(id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    void reply
      .header('content-type', row.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('accept-ranges', 'bytes')

    const range = parseByteRange(req.headers.range, row.size)
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${row.size}`).send()
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${row.size}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(createReadStream(row.path, { start: range.start, end: range.end }))
    }
    return reply.header('content-length', String(row.size)).send(createReadStream(row.path))
  })

  // Remove a shared file: the message, its blob (dedup-safe) and a system
  // note. Author or admin only — mistakes and wrong maps must be fixable.
  fastify.delete('/api/messages/:id', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const message = store.getMessageById(id)
    if (!message) return reply.code(404).send({ error: 'message not found' })
    if (message.kind !== 'file') {
      return reply.code(400).send({ error: 'only shared files can be deleted' })
    }
    if (message.authorId !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: 'you can only delete your own files' })
    }
    store.deleteMessage(id)
    hub.announceDeleted(message.channelId, id)
    hub.systemMessage(message.channelId, `${user.name} removed a shared file`)
    return { ok: true }
  })

  // Voice: mint a LiveKit room token for a channel's intercom room.
  fastify.post('/api/voice/token', async (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    if (!livekit?.url) return reply.code(503).send({ error: 'voice not configured' })
    const parsed = z.object({ channelId: z.string().min(1) }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
    const channel = store.getChannel(parsed.data.channelId)
    if (!channel || !store.isMember(channel.id, user.id)) {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const { AccessToken } = await import('livekit-server-sdk')
    const at = new AccessToken(livekit.key, livekit.secret, {
      identity: user.id,
      name: user.name,
      ttl: '12h',
    })
    at.addGrant({ room: channel.id, roomJoin: true, canPublish: true, canSubscribe: true })
    return { url: livekit.url, token: await at.toJwt() }
  })

  fastify.get('/api/search', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { q } = req.query as { q?: string }
    if (!q?.trim()) return { messages: [] }
    const results = store
      .searchMessages(q, 50)
      .filter((m) => store.isMember(m.channelId, user.id))
      .slice(0, 25)
    return { messages: results }
  })

  // Scrollback history, oldest → newest, for messages before beforeSeq.
  fastify.get('/api/channels/:id/messages', (req, reply) => {
    const user = authUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const channel = store.getChannel(id)
    if (!channel || !store.isMember(channel.id, user.id)) {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const parsed = historyQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' })
    const { beforeSeq, limit } = parsed.data
    const messages = store.listBefore(channel.id, beforeSeq ?? channel.lastSeq + 1, limit)
    return { messages }
  })

  // -- admin ----------------------------------------------------------------

  const authAdmin = (req: FastifyRequest, reply: FastifyReply): User | undefined => {
    const user = authUser(req)
    if (!user) {
      void reply.code(401).send({ error: 'unauthenticated' })
      return undefined
    }
    if (user.role !== 'admin') {
      void reply.code(403).send({ error: 'admin only' })
      return undefined
    }
    return user
  }

  // Reset a crew member's forgotten personal PIN. Their sessions stay valid —
  // this is recovery, not a ban.
  fastify.post('/api/admin/users/:id/pin', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const parsed = resetPinBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    const { id } = req.params as { id: string }
    if (!store.updateUserPin(id, hashPin(parsed.data.pin))) {
      return reply.code(404).send({ error: 'user not found' })
    }
    return { ok: true }
  })

  // Rename / retopic / retire a public channel.
  fastify.patch('/api/admin/channels/:id', (req, reply) => {
    const admin = authAdmin(req, reply)
    if (!admin) return reply
    const parsed = channelPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    const { id } = req.params as { id: string }
    const channel = store.getChannel(id)
    if (!channel || channel.kind !== 'public') {
      return reply.code(404).send({ error: 'channel not found' })
    }
    const { name, retired } = parsed.data
    if (name && name !== channel.name && store.getChannelByName(name)) {
      return reply.code(409).send({ error: `#${name} already exists` })
    }
    // #general anchors join announcements and the default view — keep it.
    if (retired && channel.name === 'general') {
      return reply.code(400).send({ error: 'cannot retire #general' })
    }
    const updated = store.updateChannel(id, parsed.data)!
    hub.announceChannel(updated)
    if (name && name !== channel.name && !updated.retired) {
      hub.systemMessage(updated.id, `#${channel.name} is now #${updated.name} (renamed by ${admin.name})`)
    }
    return { channel: updated }
  })

  // Editable settings + read-only server info for the admin panel.
  fastify.get('/api/admin/settings', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const stats = hub.stats()
    return {
      settings: { wifiSsid: publicConfig().wifiSsid },
      serverInfo: {
        version: APP_VERSION,
        uptimeSec: Math.round(process.uptime()),
        connections: stats.connections,
        onlineUsers: stats.onlineUsers,
        voiceEnabled: Boolean(livekit?.url),
        // Read-only: shown so admins can put the current PIN on posters.
        eventPin,
      },
    }
  })

  fastify.patch('/api/admin/settings', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const parsed = settingsPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    }
    if (parsed.data.wifiSsid !== undefined) {
      store.setSetting('wifiSsid', parsed.data.wifiSsid)
    }
    hub.announceConfig()
    return { settings: { wifiSsid: publicConfig().wifiSsid } }
  })

  // Full JSON dump for the post-event archive.
  fastify.get('/api/admin/export', (req, reply) => {
    if (!authAdmin(req, reply)) return reply
    const stamp = new Date().toISOString().slice(0, 10)
    return reply
      .header('content-disposition', `attachment; filename="inter-export-${stamp}.json"`)
      .send({
        exportedAt: Date.now(),
        users: store.listUsers(),
        channels: store.listAllChannels(),
        messages: store.listAllMessages(),
      })
  })

  return Object.assign(fastify, { hub })
}

/** Wire the /ws upgrade path onto a listening app. */
export function attachWs(app: App): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  app.hub.attach(wss)
  app.server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })
  return wss
}
