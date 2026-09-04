import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  newId,
  OUTBOX_FLUSH_GAP_MS,
  SEND_LIMIT,
  SEND_WINDOW_MS,
  type ServerMessage,
  type WelcomeMessage,
} from '@crewbox/shared'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { isPrivateIp, isRemoteConnection } from '../src/hub.ts'
import type { IncomingMessage } from 'node:http'
import { attachWs, buildApp, type App } from '../src/app.ts'

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'smoke-admin-pass'
let filesDir: string

let app: App
let db: DatabaseSync
let store: Store
let baseUrl: string
let wsUrl: string
let sockets: TestClient[]

class TestClient {
  ws: WebSocket
  received: ServerMessage[] = []
  private waiters: {
    predicate: (m: ServerMessage) => boolean
    resolve: (m: ServerMessage) => void
  }[] = []

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage
      this.received.push(msg)
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(msg)
        }
      }
    })
    sockets.push(this)
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg))
  }

  waitFor<T extends ServerMessage>(
    predicate: (m: ServerMessage) => m is T,
    timeoutMs = 2000
  ): Promise<T> {
    const existing = this.received.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m as T)
        },
      })
    })
  }

  waitForClose(timeoutMs = 2000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitForClose timed out')), timeoutMs)
      this.ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

async function join(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

/**
 * Join, then unlock the admin panel.
 *
 * Admin is no longer something the first arrival *is*, so a test that wants
 * it has to ask — which is the point of the change: the box can't end up
 * with nobody able to get in.
 */
async function joinAdmin(
  name: string
): Promise<{ token: string; headers: Record<string, string> }> {
  const token = await join(name)
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: ADMIN_PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  const { adminToken } = res.json() as { adminToken: string }
  return { token, headers: { authorization: `Bearer ${token}`, 'x-admin-token': adminToken } }
}

async function connect(
  token: string,
  cursors: Record<string, number> = {},
  headers?: Record<string, string>
): Promise<{ client: TestClient; welcome: WelcomeMessage }> {
  const client = new TestClient(wsUrl, headers)
  await client.open()
  client.send({ type: 'hello', token, cursors })
  const welcome = await client.waitFor((m): m is WelcomeMessage => m.type === 'welcome')
  return { client, welcome }
}

/** Poll the online tally until it reaches `expected` (or a timeout); returns
 *  whatever it settled on, so a mismatch fails the assertion with the real
 *  number. Presence updates on connection close are processed asynchronously. */
async function waitForOnline(expected: number, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (app.hub.stats().onlineUsers !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return app.hub.stats().onlineUsers
}

beforeEach(async () => {
  sockets = []
  filesDir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-test-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  app = buildApp({
    store,
    eventPin: EVENT_PIN,
    adminPassword: ADMIN_PASSWORD,
    filesDir,
    dataDir: filesDir,
    livekit: { url: 'ws://localhost:7880', key: 'devkey', secret: 'secret' },
    // Behind-a-proxy config so the office-badge presence test can exercise
    // forwarded-header handling; the pure-LAN ignore path is unit-tested below.
    trustProxy: true,
    logger: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  attachWs(app)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/ws`
})

afterEach(async () => {
  for (const s of sockets) s.close()
  app.hub.close()
  await app.close()
  rmSync(filesDir, { recursive: true, force: true })
})

describe('join and welcome', () => {
  it('returns channels, users and the joined user in welcome', async () => {
    const token = await join('Alex')
    const { welcome } = await connect(token)
    expect(welcome.me.name).toBe('Alex')
    // Everyone joins as a member now, including the first arrival. Admin is
    // the password, not a prize for scanning the poster first — the old rule
    // handed the box to one person and lost it entirely if they left.
    expect(welcome.me.role).toBe('member')
    expect(welcome.serverVersion).toMatch(/\d+\.\d+\.\d+/) // for client update prompts
    expect(welcome.protocolVersion).toBe(1)
    expect(welcome.config.modules).toEqual(['chat'])
    expect(welcome.channels.map((c) => c.name)).toContain('general')
    // join produced a system message in #general
    expect(welcome.missed.some((m) => m.kind === 'system' && m.body.includes('Alex joined'))).toBe(
      true
    )
  })

  it('rejects a wrong event PIN but allows re-login with personal PIN', async () => {
    await join('Alex')
    const bad = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Sam', eventPin: 'wrong', personalPin: '1234' },
    })
    expect(bad.statusCode).toBe(401)

    // Same name + right personal PIN = login, no event PIN needed.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alex', eventPin: '', personalPin: '1234' },
    })
    expect(relogin.statusCode).toBe(200)
    expect((relogin.json() as { created: boolean }).created).toBe(false)
  })

  it('locks an account after repeated wrong PINs, regardless of source IP', async () => {
    await join('Alex')
    const guess = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/join',
        headers: { 'x-forwarded-for': ip }, // trustProxy on in tests → distinct req.ip
        payload: { name: 'Alex', eventPin: '', personalPin: '0000' },
      })
    // 10 failures from 10 different IPs — the per-IP limiter never trips, but
    // the per-account limiter must, so a botnet can't out-scale it.
    for (let i = 0; i < 10; i++) {
      const r = await guess(`203.0.113.${i}`)
      expect(r.statusCode).toBe(401)
    }
    const locked = await guess('203.0.113.99')
    expect(locked.statusCode).toBe(429)
    // A different account is unaffected.
    const other = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { name: 'Sam', eventPin: EVENT_PIN, personalPin: '4242' },
    })
    expect(other.statusCode).toBe(200)
  })

  it('a correct PIN clears the account lockout counter', async () => {
    await join('Kit')
    // Distinct IPs so the per-IP limiter can't interfere with the per-account
    // assertion (each request is its own IP bucket).
    const tryPin = (pin: string, ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/join',
        headers: { 'x-forwarded-for': ip },
        payload: { name: 'Kit', eventPin: '', personalPin: pin },
      })
    for (let i = 0; i < 5; i++) await tryPin('0000', `198.51.100.${i}`)
    // Correct PIN succeeds and resets the counter, so subsequent wrong tries
    // start from zero rather than tripping the lock immediately.
    expect((await tryPin('1234', '198.51.100.50')).statusCode).toBe(200)
    for (let i = 0; i < 9; i++) {
      expect((await tryPin('0000', `198.51.100.${100 + i}`)).statusCode).toBe(401)
    }
  })

  it('deletes an account: token invalid, name freed, messages anonymized, socket dropped', async () => {
    const token = await join('Alex')
    const { client, welcome } = await connect(token)
    const general = welcome.channels.find((c) => c.name === 'general')!
    const myId = welcome.me.id

    const clientMsgId = newId()
    client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'I was here' })
    const ack = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack'
    )

    // Delete the account.
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(del.statusCode).toBe(200)

    // Live socket is closed with the auth code.
    await client.waitForClose()

    // The session token no longer authenticates.
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(me.statusCode).toBe(401)

    // The user row is gone but the message survives, anonymized.
    expect(store.getUserById(myId)).toBeUndefined()
    const msg = store.listAfter(general.id, 0, 100).find((m) => m.id === ack.message.id)
    expect(msg?.body).toBe('I was here')
    expect(msg?.authorId).toBeNull()

    // The name is available for a fresh registration (event PIN required again).
    const rejoin = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alex', eventPin: EVENT_PIN, personalPin: '5555' },
    })
    expect(rejoin.statusCode).toBe(200)
    expect((rejoin.json() as { created: boolean }).created).toBe(true)
  })
})

describe('message delivery', () => {
  it('acks the sender and broadcasts to others', async () => {
    const [tokenA, tokenB] = [await join('Alex'), await join('Sam')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)
    const general = a.welcome.channels.find((c) => c.name === 'general')!

    const clientMsgId = newId()
    a.client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'stage 2 mic check' })

    const ack = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack'
    )
    expect(ack.clientMsgId).toBe(clientMsgId)
    expect(ack.message.body).toBe('stage 2 mic check')

    const received = await b.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.clientMsgId === clientMsgId
    )
    expect(received.message.seq).toBe(ack.message.seq)
  })

  it('deduplicates retried sends (idempotency)', async () => {
    const token = await join('Alex')
    const { client, welcome } = await connect(token)
    const general = welcome.channels.find((c) => c.name === 'general')!

    const clientMsgId = newId()
    client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'once only' })
    const first = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack'
    )

    // Simulate an outbox flush retry after a reconnect-ish situation.
    client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'once only' })
    await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack' && m !== first
    )

    const stored = store.listAfter(general.id, 0, 100).filter((m) => m.body === 'once only')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toBe(first.message.id)
  })

  it('throttles a single socket flooding sends (amplification guard)', async () => {
    const token = await join('Alex')
    const { client, welcome } = await connect(token)
    const general = welcome.channels.find((c) => c.name === 'general')!

    // Fire 40 sends in a burst; the 30/10s cap must reject the excess.
    for (let i = 0; i < 40; i++) {
      client.send({ type: 'send', clientMsgId: newId(), channelId: general.id, body: `flood ${i}` })
    }
    const rejected = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'rejected' }> =>
        m.type === 'rejected' && m.reason.includes('too many')
    )
    expect(rejected.type).toBe('rejected')
    // At most the cap made it into the channel, not all 40.
    const stored = store.listAfter(general.id, 0, 200).filter((m) => m.body.startsWith('flood '))
    expect(stored.length).toBeLessThanOrEqual(30)
  })
})

describe('reconnect resync', () => {
  it('replays exactly the messages after the cursor', async () => {
    const [tokenA, tokenB] = [await join('Alex'), await join('Sam')]
    const a = await connect(tokenA)
    const general = a.welcome.channels.find((c) => c.name === 'general')!
    const cursorAtDisconnect = general.lastSeq
    a.client.close()

    const b = await connect(tokenB)
    for (const body of ['one', 'two', 'three']) {
      b.client.send({ type: 'send', clientMsgId: newId(), channelId: general.id, body })
    }
    await b.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> =>
        m.type === 'ack' && m.message.body === 'three'
    )

    const a2 = await connect(tokenA, { [general.id]: cursorAtDisconnect })
    const replayed = a2.welcome.missed.filter((m) => m.channelId === general.id)
    expect(replayed.map((m) => m.body)).toEqual(['one', 'two', 'three'])
    expect(a2.welcome.truncated).toHaveLength(0)
  })

  it('truncates huge backlogs and flags the channel', async () => {
    const token = await join('Alex')
    const general = store.getChannelByName('general')!
    for (let i = 0; i < 250; i++) {
      store.appendMessage({ channelId: general.id, authorId: null, kind: 'text', body: `m${i}` })
    }
    const { welcome } = await connect(token, { [general.id]: 1 })
    expect(welcome.truncated).toContain(general.id)
    const replayed = welcome.missed.filter((m) => m.channelId === general.id)
    expect(replayed).toHaveLength(200)
    // The replay is the newest tail, ending at the true last message.
    expect(replayed.at(-1)!.body).toBe('m249')
  })

  it('serves the tail of a truncated channel over REST', async () => {
    // The contract the client's backfill rests on. The hub's comment has
    // always said "the client backfills those channels over REST on demand";
    // the client had no such code, and this is what it now asks for — the
    // newest page of a channel it holds nothing of, addressed by the
    // `lastSeq` every welcome carries.
    const token = await join('Alex')
    const general = store.getChannelByName('general')!
    for (let i = 0; i < 250; i++) {
      store.appendMessage({ channelId: general.id, authorId: null, kind: 'text', body: `m${i}` })
    }
    const { welcome } = await connect(token, { [general.id]: 1 })
    const channel = welcome.channels.find((c) => c.id === general.id)!

    const res = await app.inject({
      method: 'GET',
      url: `/api/channels/${general.id}/messages?beforeSeq=${channel.lastSeq + 1}&limit=100`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const { messages } = res.json() as { messages: { seq: number; body: string }[] }
    expect(messages).toHaveLength(100)
    // The newest hundred, ending at the true last message — so a phone with
    // nothing gets the bottom of the channel, not the top.
    expect(messages.at(-1)!.body).toBe('m249')
    expect(messages.at(-1)!.seq).toBe(channel.lastSeq)
  })

  it('bounds the whole welcome, not just each channel', async () => {
    // A fresh client on a box with several busy channels would otherwise get
    // 200 × every channel in one frame, stringified on the event loop. The
    // global budget caps the total; the rest is flagged for the client to
    // backfill over REST.
    const token = await join('Alex')
    for (let c = 0; c < 5; c++) {
      const channel = store.createChannel(`busy-${c}`, 'public', '')
      for (let i = 0; i < 200; i++) {
        store.appendMessage({
          channelId: channel.id,
          authorId: null,
          kind: 'text',
          body: `c${c}m${i}`,
        })
      }
    }
    const { welcome } = await connect(token) // empty cursors — wants everything
    expect(welcome.missed.length).toBeLessThanOrEqual(500)
    // Channels that didn't fit the budget are flagged rather than dropped.
    expect(welcome.truncated.length).toBeGreaterThanOrEqual(1)
  })
})

describe('DMs', () => {
  it('keeps DM traffic private to its two members', async () => {
    const [tokenA, tokenB, tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)
    const c = await connect(tokenC)

    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.kind === 'dm'
    )

    const clientMsgId = newId()
    a.client.send({ type: 'send', clientMsgId, channelId: dm.channel.id, body: 'secret' })
    await b.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.clientMsgId === clientMsgId
    )

    expect(
      c.client.received.some((m) => m.type === 'msg' && m.message.channelId === dm.channel.id)
    ).toBe(false)
    // C's welcome/receives never list the DM channel either.
    expect(c.welcome.channels.some((ch) => ch.id === dm.channel.id)).toBe(false)
  })

  it('a markRead for a DM you are not in cannot make you a member', async () => {
    const [tokenA, , tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const samId = a.welcome.users.find((u) => u.name === 'Sam')!.id

    a.client.send({ type: 'openDm', userId: samId })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.kind === 'dm'
    )

    // Kit, who is not in the DM, replays a markRead for it — exactly what a
    // stale client cache does after a delete/re-register. setReadState upserts
    // channel_members, so without the membership gate this would silently make
    // Kit a member and start feeding them the DM.
    const c = await connect(tokenC)
    c.client.send({ type: 'markRead', channelId: dm.channel.id, seq: 1 })
    await new Promise((r) => setTimeout(r, 50)) // let the message be handled

    expect(store.isMember(dm.channel.id, c.welcome.me.id)).toBe(false)
    const c2 = await connect(tokenC)
    expect(c2.welcome.channels.some((ch) => ch.id === dm.channel.id)).toBe(false)
  })
})

describe('files and search', () => {
  it('uploads, attaches to a message, serves, and dedupes by content', async () => {
    const token = await join('Alex')
    const { client, welcome } = await connect(token)
    const general = welcome.channels.find((c) => c.name === 'general')!

    const upload = async (name: string) => {
      const form = new FormData()
      form.append('file', new Blob(['same-bytes'], { type: 'text/plain' }), name)
      const res = await fetch(`${baseUrl}/api/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { file: { id: string; name: string } }).file
    }

    const first = await upload('notes.txt')
    const second = await upload('copy.txt') // identical bytes → one stored blob

    const clientMsgId = newId()
    client.send({ type: 'send', clientMsgId, channelId: general.id, fileId: first.id, body: '' })
    const ack = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack'
    )
    expect(ack.message.kind).toBe('file')
    expect(ack.message.file?.name).toBe('notes.txt')

    const served = await fetch(`${baseUrl}/api/files/${first.id}/notes.txt`)
    expect(await served.text()).toBe('same-bytes')
    expect(served.headers.get('accept-ranges')).toBe('bytes')

    expect(store.getFileRow(first.id)!.path).toBe(store.getFileRow(second.id)!.path)
  })

  it('serves crew-uploaded files hardened against the stored-XSS path', async () => {
    const token = await join('Alex')

    const upload = async (blob: Blob, name: string) => {
      const form = new FormData()
      form.append('file', blob, name)
      const res = await fetch(`${baseUrl}/api/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      return ((await res.json()) as { file: { id: string; name: string } }).file
    }

    // An HTML upload — the attack — must download as an opaque octet-stream,
    // never render as a page on the app origin where the session token lives.
    const html = await upload(
      new Blob(['<script>steal()</script>'], { type: 'text/html' }),
      'evil.html'
    )
    const htmlRes = await fetch(`${baseUrl}/api/files/${html.id}/evil.html`)
    expect(htmlRes.headers.get('content-type')).toBe('application/octet-stream')
    expect(htmlRes.headers.get('content-disposition')).toContain('attachment')
    expect(htmlRes.headers.get('x-content-type-options')).toBe('nosniff')

    // SVG is an image to a human and a script host to a browser: also downloaded.
    const svg = await upload(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg')
    const svgRes = await fetch(`${baseUrl}/api/files/${svg.id}/x.svg`)
    expect(svgRes.headers.get('content-type')).toBe('application/octet-stream')
    expect(svgRes.headers.get('content-disposition')).toContain('attachment')

    // A real photo still renders inline, so <img> and previews keep working.
    const png = await upload(new Blob(['pngbytes'], { type: 'image/png' }), 'map.png')
    const pngRes = await fetch(`${baseUrl}/api/files/${png.id}/map.png`)
    expect(pngRes.headers.get('content-type')).toBe('image/png')
    expect(pngRes.headers.get('content-disposition')).toContain('inline')
    expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves a context window around a seq for search jumps', async () => {
    const token = await join('Alex')
    const { client, welcome } = await connect(token)
    const general = welcome.channels.find((c) => c.name === 'general')!

    let midSeq = 0
    for (let i = 0; i < 9; i++) {
      const clientMsgId = newId()
      client.send({ type: 'send', clientMsgId, channelId: general.id, body: `ctx ${i}` })
      const ack = await client.waitFor(
        (m): m is Extract<ServerMessage, { type: 'ack' }> =>
          m.type === 'ack' && m.clientMsgId === clientMsgId
      )
      if (i === 4) midSeq = ack.message.seq
    }

    const res = await fetch(
      `${baseUrl}/api/channels/${general.id}/context?seq=${midSeq}&radius=2`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    expect(res.status).toBe(200)
    const { messages } = (await res.json()) as { messages: { seq: number; body: string }[] }
    expect(messages.map((m) => m.seq)).toEqual([
      midSeq - 2,
      midSeq - 1,
      midSeq,
      midSeq + 1,
      midSeq + 2,
    ])
    expect(messages[2]!.body).toBe('ctx 4')
  })

  it('stores image dimensions and a client thumbnail, serving the preview', async () => {
    const token = await join('Alex')

    const form = new FormData()
    form.append('width', '4000')
    form.append('height', '3000')
    form.append('thumb', new Blob(['tiny-jpeg-bytes'], { type: 'image/jpeg' }), 'thumb')
    form.append('file', new Blob(['big-image-bytes'], { type: 'image/png' }), 'map.png')
    const res = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(200)
    const { file } = (await res.json()) as {
      file: { id: string; width?: number; height?: number; hasThumb?: boolean }
    }
    expect(file.width).toBe(4000)
    expect(file.height).toBe(3000)
    expect(file.hasThumb).toBe(true)

    const thumb = await fetch(`${baseUrl}/api/files/${file.id}/thumb`)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect(await thumb.text()).toBe('tiny-jpeg-bytes')

    // Non-images never get dimensions or a preview, even if the client lies.
    const plain = new FormData()
    plain.append('width', '4000')
    plain.append('height', '3000')
    plain.append('thumb', new Blob(['bogus'], { type: 'image/jpeg' }), 'thumb')
    plain.append('file', new Blob(['notes'], { type: 'text/plain' }), 'notes.txt')
    const plainRes = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: plain,
    })
    const plainFile = ((await plainRes.json()) as { file: { id: string; hasThumb?: boolean } }).file
    expect(plainFile.hasThumb).toBeUndefined()
    const noThumb = await fetch(`${baseUrl}/api/files/${plainFile.id}/thumb`)
    expect(noThumb.status).toBe(404)
  })

  it('accepts the upload but drops the thumbnail when it exceeds the cap', async () => {
    const token = await join('Alex')
    // 600 KB thumb > MAX_THUMB_BYTES (512 KB): the file must still upload
    // (breaking the thumb stream must not stall the following file part).
    const form = new FormData()
    form.append('width', '2000')
    form.append('height', '1500')
    form.append('thumb', new Blob(['x'.repeat(600 * 1024)], { type: 'image/jpeg' }), 'thumb')
    form.append('file', new Blob(['real-photo-bytes'], { type: 'image/png' }), 'photo.png')
    const res = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(200)
    const { file } = (await res.json()) as {
      file: { id: string; width?: number; hasThumb?: boolean }
    }
    expect(file.width).toBe(2000) // dimensions still recorded
    expect(file.hasThumb).toBeUndefined() // oversized thumb dropped
    const served = await fetch(`${baseUrl}/api/files/${file.id}/photo.png`)
    expect(await served.text()).toBe('real-photo-bytes') // the file itself survived
  })

  it('deletes a shared file: permissions, broadcast, welcome reconcile, dedup-safe blob', async () => {
    const { token: adminToken, headers: adminHeaders } = await joinAdmin('Alex')
    const authorToken = await join('Sam')
    const bystanderToken = await join('Kit')
    const author = await connect(authorToken)
    const general = author.welcome.channels.find((c) => c.name === 'general')!

    const upload = async (token: string, name: string) => {
      const form = new FormData()
      form.append('file', new Blob(['same-bytes-for-dedup'], { type: 'text/plain' }), name)
      const res = await fetch(`${baseUrl}/api/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      return ((await res.json()) as { file: { id: string } }).file
    }
    const sendFileMsg = async (fileId: string) => {
      const clientMsgId = newId()
      author.client.send({ type: 'send', clientMsgId, channelId: general.id, fileId, body: '' })
      const ack = await author.client.waitFor(
        (m): m is Extract<ServerMessage, { type: 'ack' }> =>
          m.type === 'ack' && m.clientMsgId === clientMsgId
      )
      return ack.message
    }

    // Two messages whose uploads share one deduped blob on disk.
    const fileA = await upload(authorToken, 'map-v1.txt')
    const fileB = await upload(authorToken, 'map-v2.txt')
    const msgA = await sendFileMsg(fileA.id)
    const msgB = await sendFileMsg(fileB.id)
    const sharedPath = store.getFileRow(fileA.id)!.path
    expect(store.getFileRow(fileB.id)!.path).toBe(sharedPath)

    const del = (token: string, id: string, unlocked?: Record<string, string>) =>
      fetch(`${baseUrl}/api/messages/${id}`, {
        method: 'DELETE',
        headers: unlocked ?? { authorization: `Bearer ${token}` },
      })

    // A bystander cannot delete someone else's file.
    expect((await del(bystanderToken, msgA.id)).status).toBe(403)

    // Neither can someone who *could* unlock the panel but hasn't: moderation
    // follows the unlock, not the person, so a signed-in admin browsing chat
    // has no more power over other people's files than anyone else.
    expect((await del(adminToken, msgA.id)).status).toBe(403)

    // The author can. A second connected client sees the broadcast + note.
    const watcher = await connect(bystanderToken)
    expect((await del(authorToken, msgA.id)).status).toBe(200)
    const deleted = await watcher.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'deleted' }> => m.type === 'deleted'
    )
    expect(deleted.messageId).toBe(msgA.id)
    const note = await watcher.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.kind === 'system'
    )
    expect(note.message.body).toBe('Sam removed a shared file')

    // Gone from the store; deduped blob survives while msgB references it.
    expect(store.getMessageById(msgA.id)).toBeUndefined()
    expect(existsSync(sharedPath)).toBe(true)

    // A client that was offline during the delete reconciles via welcome.
    const returning = await connect(bystanderToken)
    expect(returning.welcome.deletions).toContainEqual({
      channelId: general.id,
      messageId: msgA.id,
    })

    // With the panel unlocked, the same person can — and now the deduped blob
    // is truly orphaned.
    expect((await del(adminToken, msgB.id, adminHeaders)).status).toBe(200)
    expect(existsSync(sharedPath)).toBe(false)

    // Text messages are out of scope for deletion.
    const textId = newId()
    author.client.send({
      type: 'send',
      clientMsgId: textId,
      channelId: general.id,
      body: 'keep me',
    })
    const textAck = await author.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> =>
        m.type === 'ack' && m.clientMsgId === textId
    )
    expect((await del(adminToken, textAck.message.id)).status).toBe(400)
  })

  it('serves byte ranges (iOS media playback needs 206 responses)', async () => {
    const token = await join('Alex')
    const form = new FormData()
    form.append('file', new Blob(['0123456789'], { type: 'audio/mpeg' }), 'clip.mp3')
    const up = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    const { file } = (await up.json()) as { file: { id: string } }
    const url = `${baseUrl}/api/files/${file.id}/clip.mp3`

    const partial = await fetch(url, { headers: { range: 'bytes=2-5' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(partial.headers.get('content-length')).toBe('4')
    expect(await partial.text()).toBe('2345')

    // Open-ended and suffix forms.
    const tail = await fetch(url, { headers: { range: 'bytes=7-' } })
    expect(tail.status).toBe(206)
    expect(await tail.text()).toBe('789')
    const suffix = await fetch(url, { headers: { range: 'bytes=-3' } })
    expect(suffix.status).toBe(206)
    expect(await suffix.text()).toBe('789')

    // Out of range → 416; malformed → full 200.
    const beyond = await fetch(url, { headers: { range: 'bytes=99-' } })
    expect(beyond.status).toBe(416)
    const malformed = await fetch(url, { headers: { range: 'elephants=0-3' } })
    expect(malformed.status).toBe(200)
    expect(await malformed.text()).toBe('0123456789')
  })

  it('finds messages via full-text search, respecting DM privacy', async () => {
    const [tokenA, tokenB, tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)
    const general = a.welcome.channels.find((c) => c.name === 'general')!

    a.client.send({
      type: 'send',
      clientMsgId: newId(),
      channelId: general.id,
      body: 'the generator needs diesel',
    })
    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.kind === 'dm'
    )
    a.client.send({
      type: 'send',
      clientMsgId: newId(),
      channelId: dm.channel.id,
      body: 'secret diesel stash',
    })
    await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> =>
        m.type === 'ack' && m.message.body.includes('stash')
    )

    const search = async (token: string) => {
      const res = await fetch(`${baseUrl}/api/search?q=diesel`, {
        headers: { authorization: `Bearer ${token}` },
      })
      return ((await res.json()) as { messages: { body: string }[] }).messages.map((m) => m.body)
    }

    expect(await search(tokenA)).toEqual(
      expect.arrayContaining(['the generator needs diesel', 'secret diesel stash'])
    )
    // Kit sees the public hit but never the DM.
    expect(await search(tokenC)).toEqual(['the generator needs diesel'])
  })

  it('drops deleted messages from the search index', () => {
    const general = store.getChannelByName('general')!
    const kept = store.appendMessage({
      channelId: general.id,
      authorId: null,
      kind: 'text',
      body: 'diesel topup at noon',
    }).message
    const doomed = store.appendMessage({
      channelId: general.id,
      authorId: null,
      kind: 'text',
      body: 'diesel spill cleanup',
    }).message
    expect(store.searchMessages('diesel', 10).map((m) => m.id)).toEqual(
      expect.arrayContaining([kept.id, doomed.id])
    )

    db.prepare('DELETE FROM messages WHERE id = ?').run(doomed.id)

    const hits = store.searchMessages('diesel', 10).map((m) => m.id)
    expect(hits).toContain(kept.id)
    expect(hits).not.toContain(doomed.id)

    // The deleted row had the max rowid, so the next insert reuses it. Without
    // the delete trigger the orphaned index entry would match this new message.
    const successor = store.appendMessage({
      channelId: general.id,
      authorId: null,
      kind: 'text',
      body: 'stage two lineup',
    }).message
    expect(store.searchMessages('spill', 10)).toEqual([])
    expect(store.searchMessages('lineup', 10).map((m) => m.id)).toEqual([successor.id])
  })
})

describe('remote access', () => {
  it('classifies LAN vs public addresses (incl. hex-mapped IPv6)', () => {
    for (const ip of [
      '10.0.2.2',
      '192.168.8.14',
      '172.20.1.9',
      '127.0.0.1',
      '::1',
      '::ffff:192.168.1.2',
      '::ffff:c0a8:0164',
      'fe80::1', // c0a8:0164 = 192.168.1.100
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of [
      '203.0.113.9',
      '8.8.8.8',
      '::ffff:203.0.113.9',
      '::ffff:cb00:7109',
      '2001:db8::1',
      '172.32.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  it('only trusts forwarded IP headers when trustProxy is set', () => {
    const fake = (headers: Record<string, string>, remoteAddress: string) =>
      ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage
    // Pure-LAN deploy (trustProxy off): a spoofed public header is ignored,
    // so a crew member can't forge an 'office' badge — socket addr wins.
    expect(isRemoteConnection(fake({ 'cf-connecting-ip': '8.8.8.8' }, '192.168.1.5'), false)).toBe(
      false
    )
    // Behind a trusted proxy: the forwarded client IP is honoured.
    expect(isRemoteConnection(fake({ 'cf-connecting-ip': '8.8.8.8' }, '127.0.0.1'), true)).toBe(
      true
    )
    expect(isRemoteConnection(fake({ 'cf-connecting-ip': '192.168.1.5' }, '127.0.0.1'), true)).toBe(
      false
    )
  })

  it('expires idle sessions past the TTL and prunes them', async () => {
    const token = await join('Alex')
    expect(store.getSessionUser(token, 60_000)?.name).toBe('Alex')
    // Age the session two minutes; a one-minute TTL must reject it.
    db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 120_000)
    expect(store.getSessionUser(token, 60_000)).toBeUndefined()
    expect(store.getSessionUser(token)).toBeDefined() // no TTL → still valid
    expect(store.pruneSessions(60_000)).toBe(1)
    expect(store.getSessionUser(token)).toBeUndefined()
  })

  it('marks users connected only from off-site, clearing when a LAN socket appears', async () => {
    const officeToken = await join('Warehouse')
    const siteToken = await join('Sitey')
    // Off-site: public client IP via the header cloudflared sets.
    const office = await connect(officeToken, {}, { 'cf-connecting-ip': '203.0.113.9' })
    const site = await connect(siteToken)
    expect(site.welcome.remote).toContain(office.welcome.me.id)
    expect(site.welcome.remote).not.toContain(site.welcome.me.id)

    // The office user's phone joins the site Wi-Fi → badge clears live.
    await connect(officeToken)
    const update = await site.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'presence' }> =>
        m.type === 'presence' && m.userId === office.welcome.me.id && m.remote === false
    )
    expect(update.online).toBe(true)
  })

  it('a repeated hello on one socket does not leak the user online after it closes', async () => {
    // The bug: onHello marked the user online every time, but close decrements
    // once — so a client re-sending hello on the same socket inflated the
    // online tally, and the user stayed "online" with no socket after closing.
    const token = await join('Echo')
    const { client } = await connect(token)
    expect(await waitForOnline(1)).toBe(1)

    // Second hello on the same socket (a retrying or misbehaving client).
    // Messages and the close frame are ordered, so the server processes this
    // hello before the close below.
    client.send({ type: 'hello', token })
    client.close()

    // With the leak, onlineUsers never returns to 0; the fix balances it.
    expect(await waitForOnline(0)).toBe(0)
  })
})

describe('voice', () => {
  it('mints room tokens for channel members and refuses outsiders', async () => {
    const [tokenA, tokenB, tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)

    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.kind === 'dm'
    )

    const mint = (token: string, channelId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/voice/token',
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId },
      })

    const ok = await mint(tokenA, dm.channel.id)
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { token: string }).token.length).toBeGreaterThan(20)

    // Kit is not in the DM → no token for its voice room.
    const denied = await mint(tokenC, dm.channel.id)
    expect(denied.statusCode).toBe(404)
  })
})

describe('admin', () => {
  it('rejects non-admins and unauthenticated callers on every admin route', async () => {
    await join('Alex') // first user → admin
    const memberToken = await join('Sam')
    const sam = store.getUserByName('Sam')!
    const general = store.getChannelByName('general')!

    const calls = [
      { method: 'GET' as const, url: '/api/admin/export' },
      {
        method: 'PATCH' as const,
        url: `/api/admin/channels/${general.id}`,
        payload: { topic: 'x' },
      },
      { method: 'POST' as const, url: `/api/admin/users/${sam.id}/pin`, payload: { pin: '4321' } },
    ]
    for (const call of calls) {
      const anon = await app.inject(call)
      expect(anon.statusCode).toBe(401)
      const member = await app.inject({
        ...call,
        headers: { authorization: `Bearer ${memberToken}` },
      })
      expect(member.statusCode).toBe(403)
    }
  })

  it('resets a personal PIN so the old one stops working', async () => {
    const { headers: adminHeaders } = await joinAdmin('Alex')
    await join('Sam')
    const sam = store.getUserByName('Sam')!

    const badPin = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${sam.id}/pin`,
      headers: adminHeaders,
      payload: { pin: '12' },
    })
    expect(badPin.statusCode).toBe(400)

    const reset = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${sam.id}/pin`,
      headers: adminHeaders,
      payload: { pin: '4321' },
    })
    expect(reset.statusCode).toBe(200)

    const oldPin = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Sam', eventPin: '', personalPin: '1234' },
    })
    expect(oldPin.statusCode).toBe(401)

    const newPin = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Sam', eventPin: '', personalPin: '4321' },
    })
    expect(newPin.statusCode).toBe(200)
    expect((newPin.json() as { created: boolean }).created).toBe(false)
  })

  it('renames a channel, edits its topic, and broadcasts the change', async () => {
    const { token: adminToken, headers: adminHeaders } = await joinAdmin('Alex')
    const { client } = await connect(adminToken)
    const stage = store.createChannel('stage', 'public', 'old topic')

    const collision = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${stage.id}`,
      headers: adminHeaders,
      payload: { name: 'general' },
    })
    expect(collision.statusCode).toBe(409)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${stage.id}`,
      headers: adminHeaders,
      payload: { name: 'stage-2', topic: 'headliners only' },
    })
    expect(res.statusCode).toBe(200)
    const { channel } = res.json() as { channel: { name: string; topic: string } }
    expect(channel.name).toBe('stage-2')
    expect(channel.topic).toBe('headliners only')

    const broadcast = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.id === stage.id
    )
    expect(broadcast.channel.name).toBe('stage-2')
    // The rename leaves a trail in the channel itself.
    const note = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.kind === 'system' && m.message.channelId === stage.id
    )
    expect(note.message.body).toContain('#stage-2')
  })

  it('retires a channel: hidden from welcome, rejects sends, keeps #general', async () => {
    const { token: adminToken, headers: adminHeaders } = await joinAdmin('Alex')
    const stage = store.createChannel('stage', 'public')
    const general = store.getChannelByName('general')!

    const keepGeneral = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${general.id}`,
      headers: adminHeaders,
      payload: { retired: true },
    })
    expect(keepGeneral.statusCode).toBe(400)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${stage.id}`,
      headers: adminHeaders,
      payload: { retired: true },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { channel: { retired: boolean } }).channel.retired).toBe(true)

    const { client, welcome } = await connect(adminToken)
    expect(welcome.channels.some((c) => c.id === stage.id)).toBe(false)

    const clientMsgId = newId()
    client.send({ type: 'send', clientMsgId, channelId: stage.id, body: 'anyone here?' })
    const rejected = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'rejected' }> => m.type === 'rejected'
    )
    expect(rejected.clientMsgId).toBe(clientMsgId)
    expect(rejected.reason).toBe('channel retired')
  })

  it('exports users, channels (including retired and DMs) and all messages', async () => {
    const { token: adminToken, headers: adminHeaders } = await joinAdmin('Alex')
    const memberToken = await join('Sam')
    const a = await connect(adminToken)
    const b = await connect(memberToken)
    const general = a.welcome.channels.find((c) => c.name === 'general')!

    a.client.send({
      type: 'send',
      clientMsgId: newId(),
      channelId: general.id,
      body: 'load out at 6',
    })
    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.kind === 'dm'
    )
    a.client.send({
      type: 'send',
      clientMsgId: newId(),
      channelId: dm.channel.id,
      body: 'dm for the archive',
    })
    await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> =>
        m.type === 'ack' && m.message.body.includes('archive')
    )
    const stage = store.createChannel('stage', 'public')
    store.updateChannel(stage.id, { retired: true })

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/export',
      headers: adminHeaders,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')

    const dump = res.json() as {
      exportedAt: number
      users: { name: string }[]
      channels: { id: string; retired?: boolean }[]
      messages: { body: string }[]
    }
    expect(dump.users.map((u) => u.name).sort()).toEqual(['Alex', 'Sam'])
    expect(dump.channels.map((c) => c.id)).toEqual(
      expect.arrayContaining([general.id, dm.channel.id, stage.id])
    )
    expect(dump.channels.find((c) => c.id === stage.id)?.retired).toBe(true)
    expect(dump.messages.map((m) => m.body)).toEqual(
      expect.arrayContaining(['load out at 6', 'dm for the archive'])
    )
  })
})

describe('settings & config', () => {
  it('serves public config and reflects an admin Wi-Fi SSID change everywhere', async () => {
    const { token: adminToken, headers: adminHeaders } = await joinAdmin('Alex')
    const memberToken = await join('Sam')

    // Public config: default empty SSID, voice enabled (livekit set in setup).
    const initial = await (await fetch(`${baseUrl}/api/config`)).json()
    expect(initial).toEqual({
      eventName: '',
      wifiSsid: '',
      voiceEnabled: true,
      modules: ['chat'],
    })

    // A member cannot change settings.
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { wifiSsid: 'HackNet' },
    })
    expect(denied.statusCode).toBe(403)

    // An admin can. A connected client gets a live `config` broadcast.
    const listener = await connect(memberToken)
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: adminHeaders,
      payload: { wifiSsid: 'CrewNet' },
    })
    expect(ok.statusCode).toBe(200)

    const pushed = await listener.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'config' }> => m.type === 'config'
    )
    expect(pushed.config.wifiSsid).toBe('CrewNet')

    // Public endpoint and a fresh welcome both show the new value.
    const after = (await (await fetch(`${baseUrl}/api/config`)).json()) as { wifiSsid: string }
    expect(after.wifiSsid).toBe('CrewNet')
    const fresh = await connect(adminToken)
    expect(fresh.welcome.config.wifiSsid).toBe('CrewNet')
  })

  it('exposes read-only server info (incl. event PIN) to admins only', async () => {
    const { headers: adminHeaders } = await joinAdmin('Alex')
    const memberToken = await join('Sam')

    const asMember = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${memberToken}` },
    })
    expect(asMember.statusCode).toBe(403)

    const asAdmin = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: adminHeaders,
    })
    expect(asAdmin.statusCode).toBe(200)
    const body = asAdmin.json() as {
      settings: { wifiSsid: string }
      serverInfo: { eventPin: string; voiceEnabled: boolean; version: string }
    }
    expect(body.serverInfo.eventPin).toBe(EVENT_PIN)
    expect(body.serverInfo.voiceEnabled).toBe(true)
    expect(body.serverInfo.version).toMatch(/\d+\.\d+\.\d+/)
  })
})

describe('heartbeat', () => {
  it('echoes ping timestamps for client RTT measurement', async () => {
    const token = await join('Alex')
    const { client } = await connect(token)
    const t = Date.now() - 1234
    client.send({ type: 'ping', t })
    const pong = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'pong' }> => m.type === 'pong'
    )
    expect(pong.t).toBe(t)
  })
})

describe('read state', () => {
  it("syncs markRead to the same user's other devices", async () => {
    const token = await join('Alex')
    const phone = await connect(token)
    const laptop = await connect(token)
    const general = phone.welcome.channels.find((c) => c.name === 'general')!

    phone.client.send({ type: 'markRead', channelId: general.id, seq: general.lastSeq })
    const synced = await laptop.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'readState' }> => m.type === 'readState'
    )
    expect(synced.channelId).toBe(general.id)
    expect(synced.seq).toBe(general.lastSeq)
  })
})

describe('onboarding & runtime settings', () => {
  it('lets an admin change the event PIN at runtime, gating new joins', async () => {
    const { headers: adminHeaders } = await joinAdmin('Alex')
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: adminHeaders,
      payload: { eventPin: '7777' },
    })
    expect(patch.statusCode).toBe(200)
    expect((patch.json() as { settings: { eventPin: string } }).settings.eventPin).toBe('7777')

    // The old PIN no longer admits new crew; the new one does.
    const oldPin = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Late Larry', eventPin: EVENT_PIN, personalPin: '1234' },
    })
    expect(oldPin.statusCode).toBe(401)
    const newPin = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Late Larry', eventPin: '7777', personalPin: '1234' },
    })
    expect(newPin.statusCode).toBe(200)

    // The admin panel shows the effective PIN.
    const settings = await app.inject({
      url: '/api/admin/settings',
      headers: adminHeaders,
    })
    expect((settings.json() as { serverInfo: { eventPin: string } }).serverInfo.eventPin).toBe(
      '7777'
    )
  })

  it('serves the /connect onboarding page with QR, PIN, and no auth', async () => {
    const res = await fetch(`${baseUrl}/connect`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<svg')
    expect(html).toContain(`Event PIN: <strong>${EVENT_PIN}</strong>`)
    // The URL under the QR is the join link itself, PIN prefilled — on a
    // phone this page was shared to, tapping it is scanning it.
    expect(html).toMatch(new RegExp(`<a href="https?://[^"]+/\\?pin=${EVENT_PIN}">`))
    // No APK installed in this test — the download link must not appear.
    expect(html).not.toContain('crewbox.apk')
  })

  it('reflects a runtime PIN change on /connect immediately', async () => {
    const { headers: adminHeaders } = await joinAdmin('Alex')
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: adminHeaders,
      payload: { eventPin: '2468' },
    })
    const html = await (await fetch(`${baseUrl}/connect`)).text()
    expect(html).toContain('Event PIN: <strong>2468</strong>')
  })

  it('serves crewbox.apk from DATA_DIR when installed, 404 otherwise', async () => {
    const missing = await fetch(`${baseUrl}/crewbox.apk`)
    expect(missing.status).toBe(404)

    writeFileSync(pathJoin(filesDir, 'crewbox.apk'), 'not-a-real-apk')
    const found = await fetch(`${baseUrl}/crewbox.apk`)
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toBe('application/vnd.android.package-archive')
    expect(await found.text()).toBe('not-a-real-apk')

    // Once installed, /connect advertises the download.
    const html = await (await fetch(`${baseUrl}/connect`)).text()
    expect(html).toContain('crewbox.apk')
  })

  it('serves the newest crewbox*.apk under the stable /crewbox.apk URL', async () => {
    // Release assets carry the version in the filename (crewbox-v0.9.5.apk),
    // so the box accepts any crewbox*.apk as downloaded — no rename step.
    // Newest by mtime wins, so upgrading is dropping a file beside the old one.
    writeFileSync(pathJoin(filesDir, 'crewbox.apk'), 'old-apk')
    const old = new Date('2020-01-01')
    utimesSync(pathJoin(filesDir, 'crewbox.apk'), old, old)
    writeFileSync(pathJoin(filesDir, 'crewbox-v9.9.9.apk'), 'versioned-apk')

    const res = await fetch(`${baseUrl}/crewbox.apk`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('versioned-apk')
    // The download is named after the real file — the version survives onto
    // the phone — while the URL never changes, so posters don't go stale.
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="crewbox-v9.9.9.apk"')
  })
})

/**
 * The outbox a phone brings back from a dead spot.
 *
 * The flood guard exists to stop one authenticated socket fanning out
 * unbounded traffic, and thirty messages in ten seconds is implausibly fast
 * for a human. A phone flushing an outbox is not a human. It came back from
 * a dead spot with everything the crew member had typed, sent it in one go,
 * and every frame past the thirtieth was refused — by a limit that has
 * nothing to say about whether the message was any good.
 *
 * The client then deleted each rejection from IndexedDB, so those messages
 * were gone, on the screen that had promised "Nothing is lost while this
 * lasts". `retry` is what tells it the difference.
 */
describe('replaying more than the flood guard allows', () => {
  const replay = async (count: number) => {
    const token = await join('Dead Spot')
    const { client, welcome } = await connect(token)
    const channelId = welcome.channels[0]!.id
    const ids = Array.from({ length: count }, () => newId())
    for (const clientMsgId of ids) {
      client.send({ type: 'send', clientMsgId, channelId, body: `queued ${clientMsgId}` })
    }
    return { client, ids }
  }

  it('refuses the ones past the limit, as it always did', async () => {
    const { client } = await replay(SEND_LIMIT + 5)
    await client.waitFor((m): m is ServerMessage => m.type === 'rejected')
    const rejected = client.received.filter((m) => m.type === 'rejected')
    expect(rejected.length).toBeGreaterThan(0)
  })

  it('marks every one of them retryable, so nothing is thrown away', async () => {
    // The whole fix in one assertion: the client keeps what carries `retry`.
    const { client } = await replay(SEND_LIMIT + 5)
    await client.waitFor((m): m is ServerMessage => m.type === 'rejected')
    await new Promise((r) => setTimeout(r, 100))
    const rejected = client.received.filter(
      (m): m is Extract<ServerMessage, { type: 'rejected' }> => m.type === 'rejected'
    )
    expect(rejected.length).toBe(5)
    for (const r of rejected) expect(r.retry).toBe(true)
  })

  it('still takes the ones inside the limit', async () => {
    const { client, ids } = await replay(SEND_LIMIT + 5)
    await client.waitFor((m): m is ServerMessage => m.type === 'rejected')
    await new Promise((r) => setTimeout(r, 100))
    const acked = client.received.filter((m) => m.type === 'ack')
    expect(acked.length).toBe(SEND_LIMIT)
    // And the rejected ones are the tail, not an arbitrary five.
    const rejectedIds = new Set(
      client.received.filter((m) => m.type === 'rejected').map((m) => m.clientMsgId)
    )
    expect([...rejectedIds]).toEqual(ids.slice(SEND_LIMIT))
  })

  it('does not mark a real refusal retryable', async () => {
    // A message to a channel that does not exist is a fact about the
    // message: waiting changes nothing, and keeping it queued for ever would
    // be worse than dropping it. Only the flood guard is temporary.
    const token = await join('No Such Channel')
    const { client } = await connect(token)
    client.send({
      type: 'send',
      clientMsgId: newId(),
      channelId: newId(),
      body: 'into the void',
    })
    const rejected = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'rejected' }> => m.type === 'rejected'
    )
    expect(rejected.reason).toContain('channel not found')
    expect(rejected.retry).toBeUndefined()
  })

  it('paces a replay under the limit, given the gap the client uses', () => {
    // The client's gap is derived from these numbers rather than guessed, so
    // this is the arithmetic that keeps them honest: a full window of
    // replayed frames has to fit inside the allowance with headroom for the
    // crew member typing while their phone catches up.
    const inOneWindow = Math.floor(SEND_WINDOW_MS / OUTBOX_FLUSH_GAP_MS)
    expect(inOneWindow).toBeLessThan(SEND_LIMIT)
    expect(SEND_LIMIT - inOneWindow).toBeGreaterThanOrEqual(10)
  })
})

/**
 * A full disk, and everybody signed out.
 *
 * `touchSession` is an UPDATE and it sat above `conn.user = user`, so on a
 * disk with no room the throw left an authenticated crew member on an
 * unauthenticated socket. Their next frame earned "hello required first" —
 * sent as `code: 'auth'`, which the client reads as a dead session: token
 * dropped, IndexedDB wiped, outbox and all, back to the join screen.
 * Re-joining then failed too, because that is another write. One box short of
 * disk, every phone on site signed out with its unsent messages gone.
 *
 * Two separate mistakes, so two separate fixes: bookkeeping does not gate
 * authentication, and a fact about one socket is not a verdict on a session.
 */
describe('when the box cannot write session bookkeeping', () => {
  it('still authenticates the crew member', async () => {
    const token = await join('Full Disk')
    // The one write `onHello` does that is not the session lookup.
    const failing = () => {
      throw new Error('SQLITE_FULL: database or disk is full')
    }
    const original = store.touchSession.bind(store)
    store.touchSession = failing
    try {
      const { welcome } = await connect(token)
      expect(welcome.me.name).toBe('Full Disk')
    } finally {
      store.touchSession = original
    }
  })

  it('lets that connection go on sending', async () => {
    // The part that actually cost people their messages: an unauthenticated
    // socket refuses the next frame, and the refusal used to end the session.
    const token = await join('Full Disk Sends')
    const original = store.touchSession.bind(store)
    store.touchSession = () => {
      throw new Error('SQLITE_FULL: database or disk is full')
    }
    let welcome
    try {
      ;({ welcome } = await connect(token))
    } finally {
      store.touchSession = original
    }
    const client = sockets.at(-1)!
    const clientMsgId = newId()
    client.send({
      type: 'send',
      clientMsgId,
      channelId: welcome.channels[0]!.id,
      body: 'still here',
    })
    const ack = await client.waitFor((m): m is ServerMessage => m.type === 'ack')
    expect(ack).toMatchObject({ clientMsgId })
  })
})

describe('a socket that has not said hello', () => {
  it('is told about the socket, not about the session', async () => {
    // `auth` is the only code that ends somebody's session, so this must not
    // be it: a box under load or short of disk can produce this with the
    // session perfectly intact.
    const client = new TestClient(wsUrl)
    await client.open()
    client.send({ type: 'markRead', channelId: 'general', seq: 1 })
    const error = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error'
    )
    expect(error.code).toBe('handshake')
    expect(error.code).not.toBe('auth')
  })

  it('still says `auth` when the session really is invalid', async () => {
    // The distinction has to cut both ways, or it is just a rename.
    const client = new TestClient(wsUrl)
    await client.open()
    client.send({ type: 'hello', token: 'not-a-real-token', cursors: {} })
    const error = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error'
    )
    expect(error.code).toBe('auth')
  })
})
