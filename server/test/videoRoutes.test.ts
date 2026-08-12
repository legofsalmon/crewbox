import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProcessorStatus, VideoIntent } from '@crewbox/shared'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, type App } from '../src/app.ts'
import { VideoService } from '../src/video/service.ts'
import type { ScanIo } from '../src/video/discovery.ts'
import type { WatcherIo } from '../src/video/watcher.ts'

/**
 * The HTTP surface, which is where the promise is actually kept.
 *
 * "Watch the wall, don't drive it" and "only admins, only with a double
 * confirmation" are properties of these routes, not of the pane. Somebody
 * with a session token and curl is the threat model this file is written
 * against — everything here is a way of trying to get a packet onto a video
 * network in one request.
 */

const EVENT_PIN = '9999'
const ADMIN_PASSWORD = 'let-me-in'

let dir: string
let db: DatabaseSync
let store: Store
let app: App
let video: VideoService
/** Every URL the fake HTTP client was asked for, so a test can assert silence. */
let contacted: string[]
let probesSent: number

const NEVER_ANSWERS: WatcherIo = {
  coex: {
    fetch: (url) => {
      contacted.push(url)
      return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) })
    },
    now: () => Date.now(),
    wait: () => Promise.resolve(),
  },
  // Nothing at that address. Modelled as the ICMP unreachable a LAN actually
  // produces rather than as silence, which is both truer and stops every test
  // in this file waiting out the SNMP timeout.
  snmp: {
    createSocket: () =>
      ({
        on: () => {},
        send: (_b: Buffer, _p: number, _h: string, cb?: (e: Error | null) => void) => {
          contacted.push('snmp')
          cb?.(new Error('EHOSTUNREACH'))
        },
        close: () => {},
      }) as never,
    now: () => Date.now(),
  },
  now: () => Date.now(),
}

const SCAN_IO: ScanIo = {
  createSocket: () =>
    ({
      once: () => {},
      on: () => {},
      bind: (_port: number, _addr: unknown, cb?: () => void) => {
        const done = typeof _addr === 'function' ? (_addr as () => void) : cb
        done?.()
      },
      setBroadcast: () => {},
      send: (_b: Buffer, _p: number, _h: string, cb?: (e: Error | null) => void) => {
        probesSent++
        cb?.(null)
      },
      close: () => {},
    }) as never,
  wait: () => Promise.resolve(),
  interfaces: () =>
    ({
      eth0: [
        {
          family: 'IPv4',
          address: '10.0.30.9',
          netmask: '255.255.255.0',
          internal: false,
          mac: '',
          cidr: null,
        },
      ],
    }) as never,
}

const build = (options: { interfaceIp?: string; modules?: string[] } = {}): App => {
  video = new VideoService({
    settings: store,
    interfaceIp: options.interfaceIp ?? '10.0.30.9',
    io: NEVER_ANSWERS,
    scanIo: SCAN_IO,
  })
  return buildApp({
    store,
    eventPin: EVENT_PIN,
    adminPassword: ADMIN_PASSWORD,
    modules: options.modules ?? ['chat', 'video'],
    video,
    filesDir: dir,
    dataDir: dir,
    logger: false,
  })
}

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-video-'))
  db = openDb(':memory:')
  store = new Store(db)
  store.createChannel('general', 'public', 'Everyone')
  contacted = []
  probesSent = 0
  app = build()
})

afterEach(async () => {
  video?.stop()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const join = async (name: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
  })
  return (res.json() as { token: string }).token
}

const asAdmin = async (name = 'Alex'): Promise<{ token: string; adminToken: string }> => {
  const token = await join(name)
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/unlock',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: ADMIN_PASSWORD },
  })
  return { token, adminToken: (res.json() as { adminToken: string }).adminToken }
}

const headers = (auth: { token: string; adminToken?: string }, confirm?: string) => ({
  authorization: `Bearer ${auth.token}`,
  ...(auth.adminToken ? { 'x-admin-token': auth.adminToken } : {}),
  ...(confirm ? { 'x-video-confirm': confirm } : {}),
})

const addProcessor = async (auth: { token: string; adminToken: string }, host = '10.0.30.11') => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/video/processors',
    headers: headers(auth),
    payload: { host, name: 'Main wall' },
  })
  return (res.json() as { processor: { id: string } }).processor
}

/**
 * Let the fire-and-forget read the watch route kicks off run to completion.
 *
 * The route deliberately does not await it — a mistyped address costs half a
 * minute of timeouts, and holding the response open for that is a spinner
 * with nothing behind it. So a test that wants to assert on the *result* has
 * to wait for the poll the route started, and `tick()` will no-op while that
 * one is still in flight.
 */
const settle = async (): Promise<void> => {
  for (let n = 0; n < 4; n++) {
    await new Promise((resolve) => setImmediate(resolve))
    await video.watcher.tick()
  }
}

const raiseIntent = async (
  auth: { token: string; adminToken: string },
  action: 'scan' | 'watch',
  processorId?: string
): Promise<VideoIntent> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/video/intent',
    headers: headers(auth),
    payload: { action, ...(processorId ? { processorId } : {}) },
  })
  return (res.json() as { intent: VideoIntent }).intent
}

describe('reading is the crew"s', () => {
  it('lets any signed-in crew member see the wall', async () => {
    const token = await join('Sam')
    const res = await app.inject({
      method: 'GET',
      url: '/api/video/state',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // A screens tech should not need an admin unlock to read a temperature
    // off their phone.
    expect(res.json()).toMatchObject({ processors: [], scanning: false, canScan: true })
  })

  it('needs a session, like everything else', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/video/state' })).statusCode).toBe(401)
  })

  it('is not registered at all when the module is off', async () => {
    await app.close()
    app = build({ modules: ['chat'] })
    const token = await join('Sam')
    const res = await app.inject({
      method: 'GET',
      url: '/api/video/state',
      headers: { authorization: `Bearer ${token}` },
    })
    // A box without the module answers 404 rather than serving a pane it
    // does not offer.
    expect(res.statusCode).toBe(404)
  })
})

describe('changing what the box may contact is an admin"s', () => {
  it('refuses a plain crew member adding a processor', async () => {
    const token = await join('Sam')
    const res = await app.inject({
      method: 'POST',
      url: '/api/video/processors',
      headers: { authorization: `Bearer ${token}` },
      payload: { host: '10.0.30.11' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('adds an address without contacting it', async () => {
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    expect(processor).toMatchObject({ host: '10.0.30.11', monitored: false, source: 'manual' })
    // The whole point of the resting state: an address in the list is a note
    // about the world, not permission to talk to it.
    expect(contacted).toEqual([])
  })

  it('refuses something that is not an IPv4 address', async () => {
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/api/video/processors',
      headers: headers(auth),
      payload: { host: 'wall.local' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('is idempotent by address, so a scan run twice makes one row', async () => {
    const auth = await asAdmin()
    const first = await addProcessor(auth)
    const second = await addProcessor(auth)
    expect(second.id).toBe(first.id)
    expect(video.store.list()).toHaveLength(1)
  })

  it('removes one', async () => {
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/video/processors/${processor.id}`,
      headers: headers(auth),
    })
    expect(res.statusCode).toBe(200)
    expect(video.store.list()).toEqual([])
  })
})

describe('nothing transmits in one request', () => {
  it('refuses a scan with no confirmation', async () => {
    const auth = await asAdmin()
    const res = await app.inject({ method: 'POST', url: '/api/video/scan', headers: headers(auth) })
    // 428 Precondition Required: the request is well formed and the admin is
    // who they say they are — what is missing is the confirmation.
    expect(res.statusCode).toBe(428)
    expect(probesSent).toBe(0)
  })

  it('refuses a scan from a crew member holding a valid confirmation token', async () => {
    const admin = await asAdmin()
    const intent = await raiseIntent(admin, 'scan')
    const token = await join('Sam')
    const res = await app.inject({
      method: 'POST',
      url: '/api/video/scan',
      headers: { authorization: `Bearer ${token}`, 'x-video-confirm': intent.token },
    })
    expect(res.statusCode).toBe(403)
    expect(probesSent).toBe(0)
  })

  it('refuses another admin"s confirmation', async () => {
    const alex = await asAdmin('Alex')
    const intent = await raiseIntent(alex, 'scan')
    const robin = await asAdmin('Robin')
    const res = await app.inject({
      method: 'POST',
      url: '/api/video/scan',
      headers: headers(robin, intent.token),
    })
    expect(res.statusCode).toBe(428)
    expect(probesSent).toBe(0)
  })

  it('scans once the same admin confirms', async () => {
    const auth = await asAdmin()
    const intent = await raiseIntent(auth, 'scan')
    const res = await app.inject({
      method: 'POST',
      url: '/api/video/scan',
      headers: headers(auth, intent.token),
    })
    expect(res.statusCode).toBe(202)
    // Two packets: the directed broadcast and the multicast group.
    expect(probesSent).toBe(2)
  })

  it('will not scan twice on one confirmation', async () => {
    const auth = await asAdmin()
    const intent = await raiseIntent(auth, 'scan')
    await app.inject({
      method: 'POST',
      url: '/api/video/scan',
      headers: headers(auth, intent.token),
    })
    const again = await app.inject({
      method: 'POST',
      url: '/api/video/scan',
      headers: headers(auth, intent.token),
    })
    expect(again.statusCode).toBe(428)
    expect(probesSent).toBe(2)
  })

  it('says exactly what a scan would send, before sending it', async () => {
    const auth = await asAdmin()
    const intent = await raiseIntent(auth, 'scan')
    expect(intent.willSend[0]).toContain('rqProMI:')
    expect(intent.willSend[0]).toContain('3800')
    expect(intent.target).toContain('10.0.30.9')
  })

  it('refuses to raise a scan intent on a box with no video interface', async () => {
    await app.close()
    app = build({ interfaceIp: '' })
    const auth = await asAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/api/video/intent',
      headers: headers(auth),
      payload: { action: 'scan' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toContain('CREWBOX_VIDEO_IFACE')
  })
})

describe('watching one processor', () => {
  it('refuses to start watching without a confirmation', async () => {
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const res = await app.inject({
      method: 'POST',
      url: `/api/video/processors/${processor.id}/watch`,
      headers: headers(auth),
      payload: { monitored: true },
    })
    expect(res.statusCode).toBe(428)
    expect(contacted).toEqual([])
    expect(video.store.get(processor.id)?.monitored).toBe(false)
  })

  it('refuses a scan confirmation spent on watching', async () => {
    // The description an admin read is the thing they authorised. A "we will
    // broadcast one probe" confirmation must not start a 20-second poll.
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const scanIntent = await raiseIntent(auth, 'scan')
    const res = await app.inject({
      method: 'POST',
      url: `/api/video/processors/${processor.id}/watch`,
      headers: headers(auth, scanIntent.token),
      payload: { monitored: true },
    })
    expect(res.statusCode).toBe(428)
    expect(contacted).toEqual([])
  })

  it('refuses a confirmation raised for a different processor', async () => {
    const auth = await asAdmin()
    const one = await addProcessor(auth, '10.0.30.11')
    const two = await addProcessor(auth, '10.0.30.12')
    const intent = await raiseIntent(auth, 'watch', one.id)
    const res = await app.inject({
      method: 'POST',
      url: `/api/video/processors/${two.id}/watch`,
      headers: headers(auth, intent.token),
      payload: { monitored: true },
    })
    expect(res.statusCode).toBe(428)
  })

  it('starts watching once confirmed, and reads it straight away', async () => {
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const intent = await raiseIntent(auth, 'watch', processor.id)
    const res = await app.inject({
      method: 'POST',
      url: `/api/video/processors/${processor.id}/watch`,
      headers: headers(auth, intent.token),
      payload: { monitored: true },
    })
    expect(res.statusCode).toBe(200)
    expect(video.store.get(processor.id)?.monitored).toBe(true)
    // Nobody should have to wait 20 s to find out the address was wrong.
    expect(contacted.length).toBeGreaterThan(0)
  })

  it('names the traffic and says it cannot change the wall', async () => {
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const intent = await raiseIntent(auth, 'watch', processor.id)
    expect(intent.willSend.join(' ')).toContain('10.0.30.11:161')
    expect(intent.willSend.join(' ')).toContain('10.0.30.11:8001')
    // Packets only — the reassurance is the dialog's job, and the two sitting
    // one under the other read as protesting.
    expect(intent.willSend.join(' ')).toContain('Nothing else, and nothing until you stop it')
  })

  it('stops without any confirmation at all', async () => {
    // Anything that makes stopping harder than starting is the wrong way
    // round on a show day.
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const intent = await raiseIntent(auth, 'watch', processor.id)
    await app.inject({
      method: 'POST',
      url: `/api/video/processors/${processor.id}/watch`,
      headers: headers(auth, intent.token),
      payload: { monitored: true },
    })
    // Let the read the route started finish before clearing, or its packets
    // land in the window this test is asserting is silent.
    await settle()
    contacted = []
    const off = await app.inject({
      method: 'POST',
      url: `/api/video/processors/${processor.id}/watch`,
      headers: headers(auth),
      payload: { monitored: false },
    })
    expect(off.statusCode).toBe(200)
    expect(video.store.get(processor.id)?.monitored).toBe(false)
    await settle()
    expect(contacted).toEqual([])
  })

  it('reports an address that answers nothing as having no read path', async () => {
    const auth = await asAdmin()
    const processor = await addProcessor(auth)
    const intent = await raiseIntent(auth, 'watch', processor.id)
    await app.inject({
      method: 'POST',
      url: `/api/video/processors/${processor.id}/watch`,
      headers: headers(auth, intent.token),
      payload: { monitored: true },
    })
    await settle()
    const state = await app.inject({
      method: 'GET',
      url: '/api/video/state',
      headers: { authorization: `Bearer ${auth.token}` },
    })
    const [status] = (state.json() as { processors: ProcessorStatus[] }).processors
    // Never having had an answer is a different claim from having lost one:
    // this may be a VX4S, which has no read-only interface at all, and the
    // box cannot tell without opening a control session it refuses to open.
    expect(status.state).toBe('no-read-path')
    expect(status.summary).toContain('nothing to read')
  })
})
