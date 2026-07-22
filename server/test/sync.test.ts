import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { newId, type ServerMessage, type WelcomeMessage } from '@inter/shared'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, type App } from '../src/app.ts'

const EVENT_PIN = '9999'
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
  private waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
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

  waitFor<T extends ServerMessage>(predicate: (m: ServerMessage) => m is T, timeoutMs = 2000): Promise<T> {
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

async function connect(token: string, cursors: Record<string, number> = {}): Promise<{ client: TestClient; welcome: WelcomeMessage }> {
  const client = new TestClient(wsUrl)
  await client.open()
  client.send({ type: 'hello', token, cursors })
  const welcome = await client.waitFor((m): m is WelcomeMessage => m.type === 'welcome')
  return { client, welcome }
}

beforeEach(async () => {
  sockets = []
  filesDir = mkdtempSync(pathJoin(tmpdir(), 'inter-test-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  app = buildApp({
    store,
    eventPin: EVENT_PIN,
    filesDir,
    livekit: { url: 'ws://localhost:7880', key: 'devkey', secret: 'secret' },
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
    expect(welcome.me.role).toBe('admin') // first user becomes admin
    expect(welcome.channels.map((c) => c.name)).toContain('general')
    // join produced a system message in #general
    expect(welcome.missed.some((m) => m.kind === 'system' && m.body.includes('Alex joined'))).toBe(true)
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
})

describe('message delivery', () => {
  it('acks the sender and broadcasts to others', async () => {
    const [tokenA, tokenB] = [await join('Alex'), await join('Sam')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)
    const general = a.welcome.channels.find((c) => c.name === 'general')!

    const clientMsgId = newId()
    a.client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'stage 2 mic check' })

    const ack = await a.client.waitFor((m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack')
    expect(ack.clientMsgId).toBe(clientMsgId)
    expect(ack.message.body).toBe('stage 2 mic check')

    const received = await b.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.clientMsgId === clientMsgId,
    )
    expect(received.message.seq).toBe(ack.message.seq)
  })

  it('deduplicates retried sends (idempotency)', async () => {
    const token = await join('Alex')
    const { client, welcome } = await connect(token)
    const general = welcome.channels.find((c) => c.name === 'general')!

    const clientMsgId = newId()
    client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'once only' })
    const first = await client.waitFor((m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack')

    // Simulate an outbox flush retry after a reconnect-ish situation.
    client.send({ type: 'send', clientMsgId, channelId: general.id, body: 'once only' })
    await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> =>
        m.type === 'ack' && m !== first,
    )

    const stored = store.listAfter(general.id, 0, 100).filter((m) => m.body === 'once only')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toBe(first.message.id)
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
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack' && m.message.body === 'three',
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
})

describe('DMs', () => {
  it('keeps DM traffic private to its two members', async () => {
    const [tokenA, tokenB, tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)
    const c = await connect(tokenC)

    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> => m.type === 'channel' && m.channel.kind === 'dm',
    )

    const clientMsgId = newId()
    a.client.send({ type: 'send', clientMsgId, channelId: dm.channel.id, body: 'secret' })
    await b.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.clientMsgId === clientMsgId,
    )

    expect(
      c.client.received.some((m) => m.type === 'msg' && m.message.channelId === dm.channel.id),
    ).toBe(false)
    // C's welcome/receives never list the DM channel either.
    expect(c.welcome.channels.some((ch) => ch.id === dm.channel.id)).toBe(false)
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
    const ack = await client.waitFor((m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack')
    expect(ack.message.kind).toBe('file')
    expect(ack.message.file?.name).toBe('notes.txt')

    const served = await fetch(`${baseUrl}/api/files/${first.id}/notes.txt`)
    expect(await served.text()).toBe('same-bytes')

    expect(store.getFileRow(first.id)!.path).toBe(store.getFileRow(second.id)!.path)
  })

  it('finds messages via full-text search, respecting DM privacy', async () => {
    const [tokenA, tokenB, tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)
    const general = a.welcome.channels.find((c) => c.name === 'general')!

    a.client.send({ type: 'send', clientMsgId: newId(), channelId: general.id, body: 'the generator needs diesel' })
    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> => m.type === 'channel' && m.channel.kind === 'dm',
    )
    a.client.send({ type: 'send', clientMsgId: newId(), channelId: dm.channel.id, body: 'secret diesel stash' })
    await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack' && m.message.body.includes('stash'),
    )

    const search = async (token: string) => {
      const res = await fetch(`${baseUrl}/api/search?q=diesel`, {
        headers: { authorization: `Bearer ${token}` },
      })
      return ((await res.json()) as { messages: { body: string }[] }).messages.map((m) => m.body)
    }

    expect(await search(tokenA)).toEqual(
      expect.arrayContaining(['the generator needs diesel', 'secret diesel stash']),
    )
    // Kit sees the public hit but never the DM.
    expect(await search(tokenC)).toEqual(['the generator needs diesel'])
  })

  it('drops deleted messages from the search index', () => {
    const general = store.getChannelByName('general')!
    const kept = store.appendMessage({ channelId: general.id, authorId: null, kind: 'text', body: 'diesel topup at noon' }).message
    const doomed = store.appendMessage({ channelId: general.id, authorId: null, kind: 'text', body: 'diesel spill cleanup' }).message
    expect(store.searchMessages('diesel', 10).map((m) => m.id)).toEqual(
      expect.arrayContaining([kept.id, doomed.id]),
    )

    db.prepare('DELETE FROM messages WHERE id = ?').run(doomed.id)

    const hits = store.searchMessages('diesel', 10).map((m) => m.id)
    expect(hits).toContain(kept.id)
    expect(hits).not.toContain(doomed.id)

    // The deleted row had the max rowid, so the next insert reuses it. Without
    // the delete trigger the orphaned index entry would match this new message.
    const successor = store.appendMessage({ channelId: general.id, authorId: null, kind: 'text', body: 'stage two lineup' }).message
    expect(store.searchMessages('spill', 10)).toEqual([])
    expect(store.searchMessages('lineup', 10).map((m) => m.id)).toEqual([successor.id])
  })
})

describe('voice', () => {
  it('mints room tokens for channel members and refuses outsiders', async () => {
    const [tokenA, tokenB, tokenC] = [await join('Alex'), await join('Sam'), await join('Kit')]
    const a = await connect(tokenA)
    const b = await connect(tokenB)

    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> => m.type === 'channel' && m.channel.kind === 'dm',
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
      { method: 'PATCH' as const, url: `/api/admin/channels/${general.id}`, payload: { topic: 'x' } },
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
    const adminToken = await join('Alex')
    await join('Sam')
    const sam = store.getUserByName('Sam')!

    const badPin = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${sam.id}/pin`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { pin: '12' },
    })
    expect(badPin.statusCode).toBe(400)

    const reset = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${sam.id}/pin`,
      headers: { authorization: `Bearer ${adminToken}` },
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
    const adminToken = await join('Alex')
    const { client } = await connect(adminToken)
    const stage = store.createChannel('stage', 'public', 'old topic')

    const collision = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${stage.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'general' },
    })
    expect(collision.statusCode).toBe(409)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${stage.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'stage-2', topic: 'headliners only' },
    })
    expect(res.statusCode).toBe(200)
    const { channel } = res.json() as { channel: { name: string; topic: string } }
    expect(channel.name).toBe('stage-2')
    expect(channel.topic).toBe('headliners only')

    const broadcast = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> =>
        m.type === 'channel' && m.channel.id === stage.id,
    )
    expect(broadcast.channel.name).toBe('stage-2')
    // The rename leaves a trail in the channel itself.
    const note = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'msg' }> =>
        m.type === 'msg' && m.message.kind === 'system' && m.message.channelId === stage.id,
    )
    expect(note.message.body).toContain('#stage-2')
  })

  it('retires a channel: hidden from welcome, rejects sends, keeps #general', async () => {
    const adminToken = await join('Alex')
    const stage = store.createChannel('stage', 'public')
    const general = store.getChannelByName('general')!

    const keepGeneral = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${general.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { retired: true },
    })
    expect(keepGeneral.statusCode).toBe(400)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${stage.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { retired: true },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { channel: { retired: boolean } }).channel.retired).toBe(true)

    const { client, welcome } = await connect(adminToken)
    expect(welcome.channels.some((c) => c.id === stage.id)).toBe(false)

    const clientMsgId = newId()
    client.send({ type: 'send', clientMsgId, channelId: stage.id, body: 'anyone here?' })
    const rejected = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'rejected' }> => m.type === 'rejected',
    )
    expect(rejected.clientMsgId).toBe(clientMsgId)
    expect(rejected.reason).toBe('channel retired')
  })

  it('exports users, channels (including retired and DMs) and all messages', async () => {
    const adminToken = await join('Alex')
    const memberToken = await join('Sam')
    const a = await connect(adminToken)
    const b = await connect(memberToken)
    const general = a.welcome.channels.find((c) => c.name === 'general')!

    a.client.send({ type: 'send', clientMsgId: newId(), channelId: general.id, body: 'load out at 6' })
    a.client.send({ type: 'openDm', userId: b.welcome.me.id })
    const dm = await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'channel' }> => m.type === 'channel' && m.channel.kind === 'dm',
    )
    a.client.send({ type: 'send', clientMsgId: newId(), channelId: dm.channel.id, body: 'dm for the archive' })
    await a.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'ack' }> => m.type === 'ack' && m.message.body.includes('archive'),
    )
    const stage = store.createChannel('stage', 'public')
    store.updateChannel(stage.id, { retired: true })

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/export',
      headers: { authorization: `Bearer ${adminToken}` },
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
      expect.arrayContaining([general.id, dm.channel.id, stage.id]),
    )
    expect(dump.channels.find((c) => c.id === stage.id)?.retired).toBe(true)
    expect(dump.messages.map((m) => m.body)).toEqual(
      expect.arrayContaining(['load out at 6', 'dm for the archive']),
    )
  })
})

describe('heartbeat', () => {
  it('echoes ping timestamps for client RTT measurement', async () => {
    const token = await join('Alex')
    const { client } = await connect(token)
    const t = Date.now() - 1234
    client.send({ type: 'ping', t })
    const pong = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'pong' }> => m.type === 'pong',
    )
    expect(pong.t).toBe(t)
  })
})

describe('read state', () => {
  it('syncs markRead to the same user\'s other devices', async () => {
    const token = await join('Alex')
    const phone = await connect(token)
    const laptop = await connect(token)
    const general = phone.welcome.channels.find((c) => c.name === 'general')!

    phone.client.send({ type: 'markRead', channelId: general.id, seq: general.lastSeq })
    const synced = await laptop.client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'readState' }> => m.type === 'readState',
    )
    expect(synced.channelId).toBe(general.id)
    expect(synced.seq).toBe(general.lastSeq)
  })
})
