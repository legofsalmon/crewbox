import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIGNATURE, SUMS } from '../../scripts/web-sums.mjs'
import { buildApp } from '../src/app.ts'
import { extractWebDist } from '../src/box.ts'
import { openDb } from '../src/db.ts'
import { SCREENS_SIGNATURE, SCREENS_SUMS } from '../src/screens.ts'
import { Store } from '../src/store.ts'
import { parseManifest, verifyManifest } from '../src/update/verify.ts'
import { APP_VERSION } from '../src/version.ts'

/**
 * What a box tells an app about the screens it serves (`/api/app/screens`).
 *
 * An app will run a box's screens only when a release signed them, and it
 * does the checking itself. The box only hands over the signed list of the
 * screens in the folder it serves. So what matters here is that what comes
 * out is exactly what the release wrote, from the folder of the version the
 * box runs, and that a box with nothing signed says so plainly.
 */

const SIGN = fileURLToPath(new URL('../../scripts/sign-web.mjs', import.meta.url))
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })

let dir
let apps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-app-screens-'))
  apps = []
})
afterEach(async () => {
  for (const app of apps) await app.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A box serving the screens in `webDist`, or none at all. */
function box(webDist) {
  const store = new Store(openDb(':memory:'))
  const app = buildApp({ store, eventPin: '4242', ...(webDist ? { webDist } : {}), logger: false })
  apps.push(app)
  return app
}

/**
 * Screens as a release makes them, signed by the script a release runs. They
 * say they were built as another version than the box's, so what the box
 * says it runs can be told from what its screens claim.
 */
function screens({ signed = true } = {}) {
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<div id="root"></div>')
  writeFileSync(join(dist, 'assets', 'index-abc.js'), 'the screens')
  const info = { kind: 'crewbox-web', version: '0.0.1+screens', protocol: 1 }
  const nativeApi = { needs: 1, builtFor: 1 }
  writeFileSync(join(dist, 'crewbox-web.json'), JSON.stringify({ ...info, nativeApi }))
  if (signed) {
    execFileSync('node', [SIGN, dist], {
      env: { ...process.env, RELEASE_SIGNING_KEY: PRIVATE_PEM },
      stdio: 'pipe',
    })
  }
  return dist
}

/** Signed screens with one of the two files signing adds taken away. */
const without = (file) => () => {
  const dist = screens()
  rmSync(join(dist, file))
  return dist
}

const ask = (app) => app.inject({ method: 'GET', url: '/api/app/screens' })

describe('the signed list a box hands an app', () => {
  it('is what the release wrote, byte for byte, asked for with no sign-in', async () => {
    const dist = screens()
    const res = await ask(box(dist))
    expect(res.statusCode).toBe(200)
    const { version, sums, signature } = res.json()
    // The version the box runs, not the one its screens claim: an app runs
    // them only when the two agree, so the box mustn't answer for them.
    expect(version).toBe(APP_VERSION)
    expect(sums).toBe(readFileSync(join(dist, SUMS), 'utf8'))
    // What an app will do with it: the signature holds over what arrived, and
    // the list names the file that says which screens these are.
    expect(verifyManifest(sums, signature, [PUBLIC_PEM])).toEqual({ ok: true, keyIndex: 0 })
    expect(parseManifest(sums).has('crewbox-web.json')).toBe(true)
  })

  it('is never cached, since an update or a rollback changes it', async () => {
    const signed = await ask(box(screens()))
    expect(signed.headers['cache-control']).toBe('no-store')
    const none = await ask(box(undefined))
    expect(none.headers['cache-control']).toBe('no-store')
  })

  it.each([
    ['no screens at all', () => undefined],
    ['screens nobody signed', () => screens({ signed: false })],
    ['a list with no signature', without(SIGNATURE)],
    ['a signature with no list', without(SUMS)],
  ])('is a 404 from a box with %s', async (_, webDist) => {
    const res = await ask(box(webDist()))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'no signed screens on this box' })
  })

  /**
   * An update keeps the version it replaced on disk until nothing could need
   * it again, and a rollback serves that version's screens once more. Each
   * version's list is extracted beside its own files, so the rolled-back box
   * hands over the list that matches what it serves.
   */
  it('comes from the folder of the version the box runs, so a rollback hands over the older list', async () => {
    const version = (tag) => {
      const files = {
        'index.html': `the ${tag} screens`,
        [SUMS]: `${tag.repeat(64)}  index.html\n`,
        [SIGNATURE]: `${tag}\n`,
      }
      return extractWebDist(dir, `1.0.0+${tag}`, {
        manifest: () => Object.keys(files),
        file: (rel) => Uint8Array.from(Buffer.from(files[rel])).buffer,
      })
    }
    const older = version('a')
    const newer = version('b')
    expect((await ask(box(newer))).json()).toMatchObject({
      sums: `${'b'.repeat(64)}  index.html\n`,
    })
    const rolledBack = (await ask(box(older))).json()
    expect(rolledBack).toMatchObject({ sums: `${'a'.repeat(64)}  index.html\n`, signature: 'a' })
  })

  it('is read under the names a release writes', () => {
    expect(SCREENS_SUMS).toBe(SUMS)
    expect(SCREENS_SIGNATURE).toBe(SIGNATURE)
  })
})
