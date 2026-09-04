import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { attachWs, buildApp, mirrorOnLoopback, type App, type WsHandles } from '../src/app.ts'

/**
 * What an unauthenticated packet can do to the box.
 *
 * Everything here is reachable before any token is checked, which is what
 * makes it worth its own file: a crash on the far side of `/api/join` costs
 * one crew member their session, and a crash here costs a festival its
 * comms. Both of these were one packet.
 *
 * Every test ends by asking the box a real question over a real socket. The
 * failure being guarded is "the process is gone", and a process that has
 * exited cannot fail an assertion — only a later request can notice.
 */

let app: App
let ws: WsHandles
let db: DatabaseSync
let dir: string
let port: number

/** Send a raw request line and whatever headers, without a client library. */
const raw = (line: string, target = port): Promise<void> =>
  new Promise((resolve) => {
    const socket: Socket = connect(target, '127.0.0.1', () => {
      socket.write(line)
    })
    const done = () => {
      socket.destroy()
      resolve()
    }
    socket.on('error', done)
    socket.on('close', done)
    // Nothing is expected back; the box may simply destroy the socket.
    setTimeout(done, 300)
  })

/** The box is still there — the only assertion that means anything here. */
const stillServing = async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`)
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-abuse-'))
  db = openDb(join(dir, 'test.db'))
  app = buildApp({
    store: new Store(db),
    eventPin: '9999',
    adminPassword: 'abuse-admin-pass',
    filesDir: dir,
    dataDir: dir,
    modules: ['chat', 'patch'],
    logger: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  ws = attachWs(app)
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterEach(async () => {
  ws.terminateUpgraded()
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('an upgrade request the URL parser will not accept', () => {
  /**
   * Node's HTTP parser and WHATWG `URL` do not agree on what a request target
   * is. An absolute-form target is legal to the parser — it is how a request
   * to a proxy is written — and `http://[` gets through it while `new URL`
   * throws on the unterminated IPv6 literal. Thrown inside the socket's data
   * callback, with no `uncaughtException` handler anywhere, that is the box.
   */
  const MALFORMED =
    'GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'

  it('does not take the box with it', async () => {
    await raw(MALFORMED)
    await stillServing()
  })

  it('does not take the box with it through the loopback mirror either', async () => {
    // The mirror re-emits `upgrade` into the same handler, so it was a second
    // way in rather than a duplicate of the first.
    const close = await mirrorOnLoopback(app, 0)
    try {
      await raw(MALFORMED)
      await stillServing()
    } finally {
      await close()
    }
  })

  it('survives a run of them', async () => {
    for (let i = 0; i < 5; i++) await raw(MALFORMED)
    await stillServing()
  })

  it('still upgrades a well-formed request afterwards', async () => {
    await raw(MALFORMED)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.terminate()
  })
})

describe('a docs frame that violates the protocol', () => {
  /**
   * `ws` raises `error` for a framing violation, and an `error` event with no
   * listener is rethrown by EventEmitter — which, in a socket callback, exits
   * the process. The chat hub has always had the listener. The relay did not,
   * so a session holder could take the box down with one frame, and a patch
   * sheet over the 16 MB cap could do it by accident.
   */
  const join = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name, eventPin: '9999', personalPin: '4321' },
    })
    expect(res.statusCode).toBe(200)
    return (res.json() as { token: string }).token
  }

  it('closes the connection rather than the box', async () => {
    const token = await join('Abuse Docs')
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/docs/patch%2Fsheet-1?token=${encodeURIComponent(token)}`
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.on('error', () => {
      // The client sees its own end of the violation; this test is about the
      // server's end.
    })

    // A frame with RSV1 set and no extension negotiated: `ws` rejects it as
    // "Invalid WebSocket frame: RSV1 must be clear". Written by hand because
    // no client library will produce one.
    const stream = (socket as unknown as { _socket: Socket })._socket
    stream.write(Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]))

    await closed
    await stillServing()
  })

  it('leaves the room usable for everybody else', async () => {
    const token = await join('Abuse Bystander')
    const url = `ws://127.0.0.1:${port}/ws/docs/patch%2Fsheet-1?token=${encodeURIComponent(token)}`
    const good = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      good.once('open', resolve)
      good.once('error', reject)
    })
    const bad = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      bad.once('open', resolve)
      bad.once('error', reject)
    })
    bad.on('error', () => {})
    const badClosed = new Promise<void>((resolve) => bad.once('close', () => resolve()))
    ;(bad as unknown as { _socket: Socket })._socket.write(
      Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00])
    )
    await badClosed

    expect(good.readyState).toBe(WebSocket.OPEN)
    await stillServing()
    good.terminate()
  })
})

/**
 * The same two packets, against a box in its own process.
 *
 * Both of these end a real box: a throw inside a socket callback, and an
 * `error` event with no listener. Neither ends a vitest worker — vitest
 * catches them and reports them beside a test that passed — so the
 * in-process tests above can describe the *behaviour* and cannot prove the
 * *consequence*. Here exiting means exiting, and the assertion is the one
 * that matters: the box answered afterwards.
 */
describe('against a box that can actually die', () => {
  const FIXTURE = fileURLToPath(new URL('./fixtures/box.ts', import.meta.url))
  let child: ChildProcess
  let boxPort: number

  const start = () =>
    new Promise<void>((resolve, reject) => {
      child = spawn('npx', ['tsx', FIXTURE], { stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(
        () => reject(new Error('the box never said it was listening')),
        30_000
      )
      child.stdout?.on('data', (chunk: Buffer) => {
        const match = /listening (\d+)/.exec(String(chunk))
        if (!match) return
        boxPort = Number(match[1])
        clearTimeout(timer)
        resolve()
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

  beforeEach(start, 40_000)
  afterEach(() => {
    child.kill('SIGKILL')
  })

  /** Alive *and* answering — a wedged process is not a survivor either. */
  const boxAnswers = async () => {
    expect(child.exitCode).toBeNull()
    const res = await fetch(`http://127.0.0.1:${boxPort}/api/health`)
    expect(res.status).toBe(200)
  }

  it('survives the malformed upgrade target', async () => {
    await raw(
      'GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      boxPort
    )
    await boxAnswers()
  }, 40_000)

  it('survives a docs frame with RSV1 set', async () => {
    const res = await fetch(`http://127.0.0.1:${boxPort}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Abuse Child', eventPin: '9999', personalPin: '4321' }),
    })
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }

    const socket = new WebSocket(
      `ws://127.0.0.1:${boxPort}/ws/docs/patch%2Fsheet-1?token=${encodeURIComponent(token)}`
    )
    socket.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    ;(socket as unknown as { _socket: Socket })._socket.write(
      Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00])
    )
    await closed
    await boxAnswers()
  }, 40_000)
})
