import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'
import { buildApp, CORS_METHODS, type App } from '../src/app.ts'

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
 */

const APP_ORIGINS = ['http://localhost', 'capacitor://localhost']

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
