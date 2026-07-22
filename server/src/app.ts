import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { newId, type User } from '@inter/shared'
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

export interface AppDeps {
  store: Store
  eventPin: string
  /** Directory for uploaded files; omit to disable uploads (tests). */
  filesDir?: string
  /** LiveKit connection details; omit to disable voice. */
  livekit?: { url: string; key: string; secret: string }
  logger?: boolean
}

export type App = FastifyInstance & { hub: Hub }

export function buildApp({ store, eventPin, filesDir, livekit, logger = true }: AppDeps): App {
  const fastify = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    // Open WebSockets must never block shutdown — restarts have to be instant
    // and unattended on the festival box.
    forceCloseConnections: true,
  })
  const hub = new Hub(store, fastify.log)
  // Per-IP: every phone has its own LAN IP, so 10/min only throttles
  // PIN-guessing, not a crew rush after a briefing.
  const joinLimiter = new RateLimiter(Number(process.env.JOIN_RATE_LIMIT ?? 10), 60_000)
  if (filesDir) mkdirSync(filesDir, { recursive: true })
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
  // work without auth headers on the crew LAN.
  fastify.get('/api/files/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string; name: string }
    const row = store.getFileRow(id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return reply
      .header('content-type', row.mime)
      .header('content-length', String(row.size))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(row.path))
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
