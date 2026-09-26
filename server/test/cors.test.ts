import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, CORS_METHODS, type App } from '../src/app.ts'
import { allowsOrigin, isLoopbackOrigin } from '../src/cors.ts'

/**
 * The apps load this web app from their own package, so everything they send
 * the box comes from another origin: `http://localhost` in the Android app,
 * `capacitor://localhost` on the iPhone. For anything but a simple request
 * the web view asks the box first, and does what the answer allows.
 *
 * The box answered GET, HEAD and POST, @fastify/cors's own default, so
 * deleting an account, deleting a message and every admin PATCH failed in
 * both apps, with nothing wrong on the box and a browser at the box's own
 * address working. These hold the answer to the methods the box's routes
 * take and the web app sends.
 *
 * It also answered every other website, and a page open in a crew member's
 * browser is on the crew network, where the box shows the event PIN. These
 * hold that it answers the apps and pages on the device itself, and other
 * websites only on the keyed desk API.
 */

const APP_ORIGINS = ['http://localhost', 'capacitor://localhost']

/** Pages on the device itself: a developer's server, and the end-to-end suite's. */
const LOOPBACK_ORIGINS = [
  'https://localhost',
  'http://localhost:4299',
  'http://127.0.0.1:5173',
  'http://[::1]:4299',
]

/** Pages that are none of crewbox's, and a frame any of them can make. */
const WEBSITES = [
  'https://evil.example',
  'http://evil.example:8787',
  'null',
  // Another machine on the crew network: a box's page among them.
  'http://192.168.1.20:8787',
  // Names that only begin like loopback.
  'http://localhost.evil.example',
  'http://127.0.0.1.evil.example',
]

let dir: string
let app: App

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-cors-'))
  const store = new Store(openDb(':memory:'))
  app = buildApp({ store, eventPin: '9999', filesDir: dir, dataDir: dir, logger: false })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

/** What the web view sends before a request it may not simply make. */
const preflight = (url: string, origin: string, method: string) =>
  app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type,x-admin-token',
    },
  })

/** Every .ts file under a directory, tests aside. */
function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** The box's routes other than GET and POST, as the source registers them. */
function otherRoutes(): { method: string; url: string }[] {
  return sources(join(import.meta.dirname, '../src')).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\.(put|patch|delete)\(\s*['"`](\/[^'"`]*)/g)].map(
      (m) => ({ method: m[1].toUpperCase(), url: m[2].replace(/:[A-Za-z]+/g, 'x') })
    )
  )
}

describe('the box answers the apps for every method it takes', () => {
  it('finds the routes it checks', () => {
    // A pattern that silently matched nothing would pass everything below.
    const routes = otherRoutes()
    expect(routes).toContainEqual({ method: 'DELETE', url: '/api/me' })
    expect(routes).toContainEqual({ method: 'PATCH', url: '/api/admin/settings' })
    expect(routes.length).toBeGreaterThanOrEqual(6)
  })

  for (const origin of APP_ORIGINS) {
    it(`allows each of the box's own routes from ${origin}`, async () => {
      for (const { method, url } of otherRoutes()) {
        const res = await preflight(url, origin, method)
        expect(res.statusCode, `${method} ${url}`).toBe(204)
        expect(res.headers['access-control-allow-origin'], `${method} ${url}`).toBe(origin)
        const allowed = String(res.headers['access-control-allow-methods']).split(/,\s*/)
        expect(allowed, `${method} ${url}`).toContain(method)
      }
    })

    it(`allows the headers the apps send from ${origin}`, async () => {
      const res = await preflight('/api/admin/settings', origin, 'PATCH')
      expect(String(res.headers['access-control-allow-headers']).split(/,\s*/)).toEqual(
        expect.arrayContaining(['authorization', 'content-type', 'x-admin-token'])
      )
    })
  }

  it('allows every method the web app sends', () => {
    const sent = new Set(
      sources(join(import.meta.dirname, '../../web/src')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/method:\s*['"]([A-Z]+)['"]/g)].map((m) => m[1])
      )
    )
    expect(sent).toContain('PATCH')
    expect(sent).toContain('DELETE')
    for (const method of sent) expect(CORS_METHODS, method).toContain(method)
  })
})

describe('the box answers the apps and no other website', () => {
  it('knows a page on the device itself', () => {
    for (const origin of [...APP_ORIGINS, ...LOOPBACK_ORIGINS, 'http://127.8.9.10']) {
      expect(isLoopbackOrigin(origin), origin).toBe(true)
    }
    for (const origin of [...WEBSITES, '', 'ftp://localhost', 'file:///home/crew/page.html']) {
      expect(isLoopbackOrigin(origin), origin).toBe(false)
    }
  })

  it('answers any page on the desk API, and only there', () => {
    expect(allowsOrigin('https://evil.example', '/api/control/state?stage=Main')).toBe(true)
    expect(allowsOrigin('null', '/api/control/tally')).toBe(true)
    expect(allowsOrigin('https://evil.example', '/api/control')).toBe(false)
    expect(allowsOrigin('https://evil.example', '/api/controls')).toBe(false)
    expect(allowsOrigin('https://evil.example', '/connect?x=/api/control/')).toBe(false)
    // No origin is no browser's cross-origin request.
    expect(allowsOrigin(undefined, '/api/control/state')).toBe(false)
    expect(allowsOrigin(undefined, '/api/config')).toBe(false)
  })

  for (const origin of LOOPBACK_ORIGINS) {
    it(`answers ${origin}, a page on the device itself`, async () => {
      const res = await preflight('/api/admin/settings', origin, 'PATCH')
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe(origin)
    })
  }

  for (const origin of WEBSITES) {
    it(`doesn't show ${origin} the event PIN from the poster page`, async () => {
      const res = await app.inject({ method: 'GET', url: '/connect', headers: { origin } })
      // The box still sends the page, PIN and all, to a request from its own
      // network, as it should. It's the browser that keeps it from the site,
      // on the strength of there being no header here to say it may read it.
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('Event PIN: <strong>9999</strong>')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it(`doesn't show ${origin} the admin password on a box nobody has set up`, async () => {
      const res = await app.inject({ method: 'GET', url: '/setup', headers: { origin } })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('name="adminPassword"')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it(`refuses ${origin} anything that asks first`, async () => {
      for (const [method, url] of [
        ['POST', '/api/join'],
        ['PATCH', '/api/admin/settings'],
        ['DELETE', '/api/me'],
      ]) {
        const res = await preflight(url, origin, method)
        expect(res.statusCode, `${method} ${url}`).not.toBe(204)
        expect(res.headers['access-control-allow-origin'], `${method} ${url}`).toBeUndefined()
        expect(res.headers['access-control-allow-methods'], `${method} ${url}`).toBeUndefined()
      }
    })
  }

  it('answers any page on the desk API, which says nothing without its key', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const asked = await preflight('/api/control/message', origin, 'POST')
      expect(asked.statusCode, origin).toBe(204)
      expect(asked.headers['access-control-allow-origin'], origin).toBe(origin)

      const state = await app.inject({
        method: 'GET',
        url: '/api/control/state',
        headers: { origin },
      })
      expect(state.statusCode, origin).toBe(401)
      expect(state.headers['access-control-allow-origin'], origin).toBe(origin)
    }
  })

  it('varies every answer by origin, so a cache keeps one page’s from another', async () => {
    for (const origin of [undefined, 'https://evil.example', ...APP_ORIGINS]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/config',
        headers: origin ? { origin } : {},
      })
      expect(String(res.headers.vary).split(/,\s*/), String(origin)).toContain('Origin')
    }
  })
})
