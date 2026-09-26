import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { expect } from 'vitest'
import { WebSocket } from 'ws'
import type { WelcomeMessage } from '@crewbox/shared'
import { openDb } from '../../src/db.ts'
import { Store } from '../../src/store.ts'
import { attachWs, buildApp, type App } from '../../src/app.ts'

/**
 * A box on a free port with its sockets attached, and a way to talk to it,
 * for the alerts tests. The rest of the suite keeps its own copies; these
 * are new.
 */

export const EVENT_PIN = '9999'

/** A socket that keeps every frame it is sent and can wait for one. */
export class Client<Frame extends { type: string } = { type: string }> {
  ws: WebSocket
  received: Frame[] = []
  private waiters: { predicate: (m: Frame) => boolean; resolve: (m: Frame) => void }[] = []

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Frame
      this.received.push(msg)
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(msg)
        }
      }
    })
    // An upgrade the box refuses is an error event; the tests look at it.
    this.ws.on('error', () => {})
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`))
      )
      this.ws.once('error', reject)
    })
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg))
  }

  /** The next frame (after any already held) that matches, or a timeout. */
  waitFor<T = Frame>(predicate: (m: Frame) => boolean, timeoutMs = 2000): Promise<T> {
    const existing = this.received.find(predicate)
    if (existing) {
      this.received.splice(this.received.indexOf(existing), 1)
      return Promise.resolve(existing as unknown as T)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          this.received.splice(this.received.indexOf(m), 1)
          resolve(m as unknown as T)
        },
      })
    })
  }

  /** Frames of a type received so far, without waiting. */
  all(type: string): Frame[] {
    return this.received.filter((m) => m.type === type)
  }

  closed(timeoutMs = 2000): Promise<number> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timed out')), timeoutMs)
      this.ws.once('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

export interface Box {
  app: App
  store: Store
  port: number
  http: string
  /** Join as a new crew member; their session token. */
  join(name: string): Promise<string>
  /** Open the chat socket as somebody and wait for the welcome. */
  chat(token: string): Promise<{ client: Client; welcome: WelcomeMessage }>
  stop(): Promise<void>
}

export async function startBox(
  options: Partial<Parameters<typeof buildApp>[0]> = {}
): Promise<Box> {
  const filesDir = mkdtempSync(pathJoin(tmpdir(), 'crewbox-alerts-'))
  const store = new Store(openDb(':memory:'))
  store.createChannel('general', 'public', 'Everyone')
  const app = buildApp({
    store,
    eventPin: EVENT_PIN,
    adminPassword: 'alerts-admin-pass',
    filesDir,
    dataDir: filesDir,
    livekit: { url: 'ws://localhost:7880', key: 'devkey', secret: 'secret' },
    logger: false,
    ...options,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  attachWs(app)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const clients: Client[] = []
  return {
    app,
    store,
    port,
    http: `http://127.0.0.1:${port}`,
    async join(name) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { name, eventPin: EVENT_PIN, personalPin: '1234' },
      })
      expect(res.statusCode).toBe(200)
      return (res.json() as { token: string }).token
    },
    async chat(token) {
      const client = new Client(`ws://127.0.0.1:${port}/ws`)
      clients.push(client)
      await client.open()
      client.send({ type: 'hello', token, cursors: {} })
      const welcome = await client.waitFor<WelcomeMessage & { type: string }>(
        (m) => m.type === 'welcome'
      )
      return { client, welcome }
    },
    async stop() {
      for (const client of clients) client.close()
      app.hub.close()
      await app.close()
      rmSync(filesDir, { recursive: true, force: true })
    },
  }
}
