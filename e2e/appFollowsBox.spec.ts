import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { expect } from '@playwright/test'
import { build, type Plugin } from 'vite'
import {
  INFO,
  SIGNATURE,
  SUMS,
  judge,
  parseInfo,
  parseOffer,
  parseSums,
  signedBy,
} from '../scripts/web-sums.mjs'
import { test, uniqueName } from './helpers'

/**
 * The apps following their box, end to end (docs/UPDATING.md, "Phones follow
 * their box"): older screens in an app join a box running a newer build,
 * take the box's screens once they check out, switch to them, and show a
 * module only the newer build has.
 *
 * Everything but the app's native code is the real thing. The box is the
 * suite's own, serving this checkout's screens, signed here as a release
 * signs them but with a key made for the run. The older screens are this
 * checkout built again as another version, without the Network module, as
 * screens from before it existed would be. The app is a small server that
 * plays the app's own origin: it serves the screens the app runs, and does
 * what CrewboxScreens does natively, by the release's own rules
 * (scripts/web-sums.mjs), which shared fixtures hold the Android app to.
 */

const ROOT = process.cwd()
const DIST = join(ROOT, 'web', 'dist')
const BOX = 'http://localhost:4299'

/** The module the older screens were built without. */
const ADDED = 'network'

/** What the app's native code keeps, as this checkout's Android app is built (Screens.java). */
function appBuild(): { nativeApi: number; oldestScreensApi: number; floor: string } {
  const java = readFileSync(
    join(ROOT, 'native/android/app/src/main/java/com/colmhewson/crewbox/Screens.java'),
    'utf8'
  )
  const constant = (name: string) => {
    const found = new RegExp(`static final (?:int|String) ${name} = "?([^";]+)"?;`).exec(java)
    if (!found) throw new Error(`Screens.java has no ${name}`)
    return found[1]
  }
  return {
    nativeApi: Number(constant('NATIVE_API')),
    oldestScreensApi: Number(constant('OLDEST_SCREENS_API')),
    floor: constant('FLOOR'),
  }
}

/**
 * This checkout's screens, built into `outDir` as `version` and without the
 * module `id`: the registry they are built from, with it taken out.
 */
async function buildOlder(outDir: string, version: string, id: string): Promise<void> {
  const name = `${id}Module`
  const without: Plugin = {
    name: 'e2e-older-screens',
    enforce: 'pre',
    transform(code, file) {
      if (!file.endsWith('/src/shell/registry.ts')) return null
      const older = code
        .replace(new RegExp(`^import \\{ ${name} \\} from [^\\n]*\\n`, 'm'), '')
        .replace(new RegExp(`^ *${name},\\n`, 'm'), '')
      if (older.includes(name)) throw new Error(`${name} is still in the registry`)
      return older
    },
  }
  await build({
    root: join(ROOT, 'web'),
    configFile: join(ROOT, 'web', 'vite.config.ts'),
    logLevel: 'error',
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [without],
    build: { outDir, emptyOutDir: true },
  })
  // crewbox-web.json, which the build wrote with this checkout's version.
  const info = JSON.parse(readFileSync(join(outDir, INFO), 'utf8')) as object
  writeFileSync(join(outDir, INFO), JSON.stringify({ ...info, version }, null, 2) + '\n')
}

/** Sign `dir` as a release signs its screens, with a key made for the run. The key's 32 bytes, base64. */
function sign(dir: string): string {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'sign-web.mjs'), dir], {
    env: {
      ...process.env,
      RELEASE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    stdio: 'pipe',
  })
  const x = publicKey.export({ format: 'jwk' }).x as string
  return Buffer.from(x, 'base64url').toString('base64')
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const isFile = (path: string) => existsSync(path) && statSync(path).isFile()

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

type Answer = { result: string; version?: string; update?: string; reason?: string }

/** The app on the phone: its own origin, and what its native side has been asked. */
interface App {
  origin: string
  /** Each call the page made of CrewboxScreens, in order. */
  calls: string[]
  /** Where the app keeps the screens it takes from boxes. */
  kept: string
  close(): Promise<void>
}

/**
 * The app, as a server on its own origin. It serves the screens it runs, its
 * own until the page switches, and answers CrewboxScreens at `/__app/`,
 * which the page's stand-in plugin calls. A path with no file is the page
 * itself, as it is in a web view.
 */
async function standIn(
  own: { dir: string; version: string },
  keys: string[],
  kept: string
): Promise<App> {
  const app = appBuild()
  const calls: string[] = []
  const versions = new Map<string, string>()
  let serving = own.dir

  async function prepare(origin: string): Promise<Answer> {
    const answer = await fetch(`${origin}/api/app/screens`)
    if (answer.status === 404) return { result: 'unsigned', reason: 'no signed screens' }
    if (!answer.ok) return { result: 'failed', reason: `HTTP ${answer.status}` }
    let offer: { version: string; sums: string; signature: string }
    let listed: Map<string, string>
    try {
      offer = parseOffer(await answer.text())
      if (offer.version === own.version) return { result: 'same', version: offer.version }
      if (signedBy(offer.sums, offer.signature, keys) < 0)
        throw new Error('not a key this app trusts')
      listed = parseSums(offer.sums)
      if (!listed.has(INFO)) throw new Error(`${SUMS} doesn't list ${INFO}`)
    } catch (error) {
      return { result: 'unsigned', reason: String(error) }
    }
    const checked = async (path: string) => {
      const response = await fetch(`${origin}/${path}`)
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (sha256(bytes) !== listed.get(path)) throw new Error(`${path} isn't the file signed`)
      return bytes
    }
    try {
      // What the screens are first, so nothing more is fetched for screens
      // this build won't run.
      const info = await checked(INFO)
      const refused = judge(parseInfo(info.toString('utf8')), offer.version, app)
      if (refused?.answer === 'unsigned') return { result: 'unsigned', reason: refused.reason }
      if (refused) return { result: 'incompatible', version: offer.version, update: refused.update }
      const partial = join(kept, `.partial-${offer.version}`)
      rmSync(partial, { recursive: true, force: true })
      for (const path of listed.keys()) {
        const bytes = path === INFO ? info : await checked(path)
        mkdirSync(dirname(join(partial, path)), { recursive: true })
        writeFileSync(join(partial, path), bytes)
      }
      const folder = join(kept, offer.version)
      rmSync(folder, { recursive: true, force: true })
      renameSync(partial, folder)
      versions.set(offer.version, folder)
      return { result: 'ready', version: offer.version }
    } catch (error) {
      return { result: 'failed', reason: String(error) }
    }
  }

  const native: Record<string, (options: Record<string, string>) => Promise<unknown>> = {
    async prepare({ origin }) {
      calls.push(`prepare ${origin}`)
      return prepare(origin)
    },
    async use({ event, version }) {
      calls.push(version ? `use ${event} ${version}` : `use ${event}`)
      // The folder the web view is served from, from the next load.
      if (!version || version === own.version) serving = own.dir
      else if (versions.has(version)) serving = versions.get(version)!
      else throw new Error(`${version} isn't on this phone`)
      return {}
    },
    async ready({ version }) {
      calls.push(`ready ${version}`)
      return {}
    },
  }

  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  const text = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://app')
    if (pathname.startsWith('/__app/')) {
      const method = native[pathname.slice('/__app/'.length)]
      if (!method) return send(res, 404, '{}', 'application/json')
      try {
        const options = JSON.parse((await text(req)) || '{}') as Record<string, string>
        return send(res, 200, JSON.stringify(await method(options)), 'application/json')
      } catch (error) {
        return send(res, 500, JSON.stringify({ error: String(error) }), 'application/json')
      }
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    if (rel.split('/').includes('..')) return send(res, 400, 'no', 'text/plain')
    let file = join(serving, rel)
    if (rel === '' || (!extname(rel) && !isFile(file))) file = join(serving, 'index.html')
    if (!isFile(file)) return send(res, 404, 'not found', 'text/plain')
    send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream')
  }

  const server: Server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    kept,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let work: string
let app: App
let older: string
let newer: string
/** The signed list and its signature as the box's screens had them before this spec. */
const before = new Map<string, Buffer | null>()

// eslint-disable-next-line no-empty-pattern -- Playwright's fixture shape.
test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000)
  // The box says it runs the version its package and checkout say. Screens
  // built from another checkout can't be the ones it runs, and every app
  // would refuse them, so say so rather than fail further on.
  newer = (JSON.parse(readFileSync(join(DIST, INFO), 'utf8')) as { version: string }).version
  const box = ((await (await fetch(`${BOX}/api/health`)).json()) as { version: string }).version
  if (box !== newer) {
    throw new Error(`web/dist was built as ${newer} but the box runs ${box}: rebuild the web app`)
  }
  older = newer.replace(/\+.*$/, '+e2eolder')

  work = mkdtempSync(join(tmpdir(), 'crewbox-e2e-app-'))
  const own = join(work, 'own')
  await buildOlder(own, older, ADDED)

  for (const name of [SUMS, SIGNATURE]) {
    before.set(name, isFile(join(DIST, name)) ? readFileSync(join(DIST, name)) : null)
  }
  const key = sign(DIST)
  mkdirSync(join(work, 'kept'))
  app = await standIn({ dir: own, version: older }, [key], join(work, 'kept'))
})

test.afterAll(async () => {
  await app?.close()
  // The box's screens as they were, for the rest of the suite.
  for (const [name, bytes] of before) {
    if (bytes) writeFileSync(join(DIST, name), bytes)
    else rmSync(join(DIST, name), { force: true })
  }
  if (work) rmSync(work, { recursive: true, force: true })
})

test('older screens in the app join a newer box, switch to its screens, and show its new module', async ({
  browser,
}) => {
  test.setTimeout(60_000)
  const context = await browser.newContext()
  // The app's bridge, with the one plugin this needs, answered by the app.
  await context.addInitScript(() => {
    const native = async (method: string, options: unknown) => {
      const response = await fetch(`/__app/${method}`, {
        method: 'POST',
        body: JSON.stringify(options),
      })
      const answer = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(answer.error)
      return answer
    }
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        CrewboxScreens: {
          prepare: (options: unknown) => native('prepare', options),
          use: async (options: unknown) => {
            await native('use', options)
          },
          ready: async (options: unknown) => {
            await native('ready', options)
          },
        },
      },
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })

  // The app's own screens, which are the older build.
  await page.goto(`${app.origin}/?server=${BOX}&pin=4242`)
  await expect(page.locator('.join-version')).toHaveText(`v${older}`)
  await expect.poll(() => app.calls).toEqual([`ready ${older}`])
  await page.getByLabel('Your name').fill(uniqueName('Follower'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await expect(page.locator('.app-version')).toHaveText(`v${older}`)
  // The box has the Network module on, and these screens have never heard of it.
  const audit = page.getByRole('button', { name: 'Open network audit' })
  await expect(audit).toHaveCount(0)

  // The box runs the newer build. The app takes its screens, checked against
  // the key and the list, and only then is the switch offered.
  const pill = page.getByRole('button', { name: /New version ready/ })
  await expect(pill).toBeVisible()
  expect(app.calls).toContain(`prepare ${BOX}`)
  expect(readdirSync(app.kept)).toEqual([newer])
  expect(app.calls.filter((call) => call.startsWith('use '))).toEqual([])

  // One tap: the app serves them for the open event, and the page reloads
  // into them where it was, still signed in.
  const at = page.url()
  await pill.click()
  await expect(page.locator('.app-version')).toHaveText(`v${newer}`)
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  expect(page.url()).toBe(at)
  expect(app.calls.filter((call) => call.startsWith('use '))).toEqual([
    expect.stringMatching(new RegExp(`^use \\S+ ${newer.replace(/[.+]/g, '\\$&')}$`)),
  ])
  await expect.poll(() => app.calls).toContain(`ready ${newer}`)
  await expect(pill).toHaveCount(0)

  // And the module only the newer build has.
  await audit.click()
  await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()
  await context.close()
})
