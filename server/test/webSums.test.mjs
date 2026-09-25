import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INFO,
  LIMITS,
  SIGNATURE,
  SUMS,
  checkSignedScreens,
  checkSums,
  parseSums,
  safePath,
  screensIn,
} from '../../scripts/web-sums.mjs'
import {
  MAX_MANIFEST_BYTES,
  assetFor,
  checkAsset,
  parseManifest,
  verifyManifest,
} from '../src/update/verify.ts'

/**
 * The signed list of a release's screens, `WEBSUMS`, from both ends.
 *
 * The release writes and signs it (scripts/sign-web.mjs), every box is built
 * on the files it lists (scripts/build-box.mjs), and the apps will read it
 * before they run anything a box serves. A list those disagree about is a
 * release whose screens every phone refuses, found in a field. So the output
 * is checked here against the box's own verifier and against `sha256sum`, and
 * everything a phone would refuse has to stop the signing instead.
 */

const SIGN = fileURLToPath(new URL('../../scripts/sign-web.mjs', import.meta.url))
const CHECK = fileURLToPath(new URL('../../scripts/web-sums.mjs', import.meta.url))
const BUILT_AS = '1.2.0+abc1234'

/** macOS calls it `shasum -a 256`, so the tool is not everywhere. */
const hasSha256sum = (() => {
  try {
    execFileSync('sha256sum', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' })

const info = (fields = {}) =>
  JSON.stringify(
    {
      kind: 'crewbox-web',
      version: BUILT_AS,
      protocol: 3,
      nativeApi: { needs: 1, builtFor: 1 },
      ...fields,
    },
    null,
    2
  ) + '\n'

let root
let dist

const put = (rel, content) => {
  const path = join(dist, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** Screens shaped like a real build: compressed copies beside most files. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crewbox-websums-'))
  dist = join(root, 'dist')
  const html = '<!doctype html><div id="root"></div>'.repeat(20)
  const js = 'console.log("the screens")\n'.repeat(50)
  put('index.html', html)
  put('index.html.br', brotliCompressSync(html))
  put('index.html.gz', gzipSync(html))
  put('assets/index-Ab_9.js', js)
  put('assets/index-Ab_9.js.br', brotliCompressSync(js))
  // A .gz with nothing beside it is a file of its own, not a copy.
  put('assets/data.tar.gz', gzipSync('a tarball'))
  put('icon.svg', '<svg/>')
  put(INFO, info())
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Run the signing script; `key: undefined` runs it with no key at all. */
const sign = ({ version, ...given } = {}) => {
  const env = { ...process.env }
  delete env.RELEASE_SIGNING_KEY
  const key = 'key' in given ? given.key : PRIVATE_PEM
  if (key !== undefined) env.RELEASE_SIGNING_KEY = key
  return execFileSync('node', [SIGN, dist, ...(version ? [version] : [])], {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  })
}

/** What the script said when it refused, so a test can say why it did. */
const refusal = (run) => {
  try {
    run()
  } catch (err) {
    return String(err.stderr)
  }
  throw new Error('it did not refuse')
}

const read = () => ({
  sums: readFileSync(join(dist, SUMS), 'utf8'),
  signature: readFileSync(join(dist, SIGNATURE), 'utf8'),
})

const digest = (text) => createHash('sha256').update(text).digest('hex')

/** One line of a list, as sha256sum writes it. */
const listing = (rel, hash = digest(rel)) => `${hash}  ${rel}\n`

describe('signing the screens', () => {
  it("writes a list the box's own verifier and parser accept", () => {
    sign()
    const { sums, signature } = read()
    expect(verifyManifest(sums, signature, [PUBLIC_PEM])).toEqual({ ok: true, keyIndex: 0 })
    expect(parseManifest(sums)).toEqual(parseSums(sums))
  })

  it('lists every file the screens are made of, and no compressed copy', () => {
    sign()
    expect([...parseSums(read().sums).keys()]).toEqual([
      'assets/data.tar.gz',
      'assets/index-Ab_9.js',
      INFO,
      'icon.svg',
      'index.html',
    ])
  })

  it.skipIf(!hasSha256sum)('is accepted by the real sha256sum', () => {
    sign()
    const out = execFileSync('sha256sum', ['-c', SUMS], { cwd: dist, encoding: 'utf8' })
    expect(out).toContain('index.html: OK')
    expect(out).not.toContain('FAILED')
  })

  it.skipIf(!hasSha256sum)('and the real sha256sum catches a changed file', () => {
    sign()
    put('assets/index-Ab_9.js', 'not the screens that were signed')
    expect(() => execFileSync('sha256sum', ['-c', SUMS], { cwd: dist, stdio: 'pipe' })).toThrow()
  })

  it('gives the same bytes for the same screens, signed again', () => {
    // The second run finds the first run's list and signature in the folder,
    // and must leave them out of the new list rather than list them.
    sign()
    const first = read()
    sign()
    expect(read()).toEqual(first)
  })

  it('signs screens built as the release it is given', () => {
    expect(sign({ version: 'v1.2.0' })).toContain(`the ${BUILT_AS} screens`)
  })

  it.each(['v1.2.1', 'v1.2', 'v1.2.0-rc.1'])(
    'refuses screens built as another version than %s',
    (version) => {
      expect(refusal(() => sign({ version }))).toContain('Bump web/package.json')
      expect(existsSync(join(dist, SUMS))).toBe(false)
    }
  )
})

describe('refusing to sign screens no phone would run', () => {
  it.each([
    ['missing', undefined],
    ['empty', '   '],
  ])('fails when the key is %s', (_, key) => {
    expect(refusal(() => sign({ key }))).toContain('RELEASE_SIGNING_KEY is not set')
    expect(existsSync(join(dist, SUMS))).toBe(false)
  })

  it('fails on a key that is not a key, rather than writing a bad signature', () => {
    const bad = '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----'
    expect(refusal(() => sign({ key: bad }))).toContain('could not sign')
    expect(existsSync(join(dist, SUMS))).toBe(false)
  })

  it('fails on a key of another kind, which nothing would accept a signature from', () => {
    const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = ec.export({ type: 'pkcs8', format: 'pem' })
    expect(refusal(() => sign({ key: pem }))).toContain('not ed25519')
    expect(existsSync(join(dist, SUMS))).toBe(false)
  })

  it('fails when the screens do not say which they are', () => {
    rmSync(join(dist, INFO))
    expect(refusal(() => sign())).toContain(`${INFO} is missing`)
  })

  it.each([
    ['another kind', { kind: 'something-else' }, 'is not a crewbox-web file'],
    ['no commit', { version: '1.2.0' }, 'no version'],
    ['no protocol', { protocol: 0 }, 'no protocol'],
    ['needs over builtFor', { nativeApi: { needs: 2, builtFor: 1 } }, 'no nativeApi'],
    ['no native contract', { nativeApi: undefined }, 'no nativeApi'],
  ])('fails when %s is what the screens say', (_, fields, why) => {
    put(INFO, info(fields))
    expect(refusal(() => sign())).toContain(why)
  })

  it.each(['.env', 'assets/.hidden.js', 'a b.js', 'x%20y.js', 'é.js', 'back\\slash.js'])(
    'fails on a file called %j, which is no name a phone will write',
    (rel) => {
      put(rel, 'x')
      expect(refusal(() => sign())).toContain('is not a name a phone will write')
    }
  )

  it(`fails on more than ${LIMITS.files} files`, () => {
    for (let i = 0; i <= LIMITS.files; i++) put(`assets/chunk-${i}.js`, String(i))
    expect(refusal(() => sign())).toContain(`over the ${LIMITS.files} a phone takes`)
  })

  it(`fails on more than ${LIMITS.bytes} bytes`, () => {
    // Sparse, so the test writes almost nothing to the disk.
    put('assets/huge.bin', '')
    truncateSync(join(dist, 'assets/huge.bin'), LIMITS.bytes + 1)
    expect(refusal(() => sign())).toContain('a phone takes')
  })

  it(`fails when the list itself would be over ${LIMITS.sumsBytes} bytes`, () => {
    // Few enough files, each named at length: 400 lines of 167 bytes.
    for (let i = 0; i < 400; i++) put(`assets/${String(i).padStart(90, 'x')}.js`, String(i))
    expect(refusal(() => sign())).toContain(`${SUMS} is over ${LIMITS.sumsBytes} bytes`)
  })

  it.each([
    ['a copy of something else', () => brotliCompressSync('not index.html')],
    ['not a copy at all', () => Buffer.from('not brotli')],
  ])('fails on a compressed copy that is %s', (_, bytes) => {
    put('index.html.br', bytes())
    expect(refusal(() => sign())).toContain("index.html.br doesn't decode to the file beside it")
  })

  it('holds the list to the size the box allows its own', () => {
    expect(LIMITS.sumsBytes).toBe(MAX_MANIFEST_BYTES)
  })
})

describe('checking screens against their list', () => {
  beforeEach(() => sign())

  it('passes the screens exactly as signed, built as the box', () => {
    expect(checkSignedScreens(dist, BUILT_AS).size).toBe(5)
  })

  it('refuses them for a box of another version', () => {
    expect(() => checkSignedScreens(dist, '1.2.0+def5678')).toThrow(
      `the signed screens were built as ${BUILT_AS}, but this box is 1.2.0+def5678`
    )
  })

  it('refuses a changed file', () => {
    put('icon.svg', '<svg>changed</svg>')
    expect(() => checkSums(dist)).toThrow('icon.svg is not the file that was signed')
  })

  it('refuses a missing file', () => {
    rmSync(join(dist, 'icon.svg'))
    expect(() => checkSums(dist)).toThrow(`icon.svg is in ${SUMS} but missing`)
  })

  it('refuses a list with no signature beside it', () => {
    rmSync(join(dist, SIGNATURE))
    expect(() => checkSums(dist)).toThrow(`${SIGNATURE} is missing`)
  })

  it('lets a file the list leaves out pass, until the check is exact', () => {
    // Capacitor's cordova.js beside the screens in the Android project.
    put('cordova.js', '')
    expect(checkSums(dist).size).toBe(5)
    expect(() => checkSignedScreens(dist, BUILT_AS)).toThrow(`cordova.js is not in ${SUMS}`)
  })

  it('lets a good copy in, and not a stale one', () => {
    put('icon.svg.gz', gzipSync('<svg/>'))
    expect(checkSignedScreens(dist, BUILT_AS).size).toBe(5)
    put('icon.svg.gz', gzipSync('<svg>stale</svg>'))
    expect(() => checkSignedScreens(dist, BUILT_AS)).toThrow("icon.svg.gz doesn't decode")
  })

  it('leaves out the list and its signature, and every copy of a file', () => {
    expect(screensIn(dist)).toEqual([
      'assets/data.tar.gz',
      'assets/index-Ab_9.js',
      INFO,
      'icon.svg',
      'index.html',
    ])
  })
})

describe('reading a list, as strictly as a phone will', () => {
  it('reads what sha256sum writes', () => {
    expect(parseSums(listing('index.html') + listing('assets/a.js')).get('assets/a.js')).toBe(
      digest('assets/a.js')
    )
  })

  it.each([
    ['no newline at the end', listing('index.html').trimEnd()],
    ['no lines', '\n'],
    ['one space', `${digest('x')} index.html\n`],
    ['a binary marker', `${digest('x')} *index.html\n`],
    ['capital hex', listing('index.html', digest('x').toUpperCase())],
    ['a path out of the folder', listing('../index.html')],
    ['an absolute path', listing('/index.html')],
    ['a file listed twice', listing('index.html') + listing('index.html')],
    ['too much of it', listing('index.html').repeat(Math.ceil(LIMITS.sumsBytes / 80))],
  ])('refuses %s', (_, text) => {
    expect(() => parseSums(text)).toThrow()
  })

  it.each([
    ['index.html', true],
    ['assets/index-Ab_9.js', true],
    ['a/b/c.txt', true],
    ['', false],
    ['.hidden', false],
    ['a/.b', false],
    ['../x', false],
    ['a/../b', false],
    ['a//b', false],
    ['/abs', false],
    ['a b', false],
    ['a\\b', false],
  ])('safePath(%j) is %s', (rel, safe) => {
    expect(safePath(rel)).toBe(safe)
  })
})

/**
 * Both lists are signed by the same key, so each has to be useless where the
 * other is expected: a box's updater looks for its own binary, which the
 * screens' list never names, and an app wants the screens' own file, which a
 * release's list never names.
 */
describe("the two signed lists can't stand in for each other", () => {
  it("the screens' list gives a box's updater nothing to install", () => {
    sign()
    const listed = parseManifest(read().sums)
    for (const platform of ['linux', 'win32', 'darwin']) {
      const asset = assetFor('v1.2.0', platform)
      expect(checkAsset(asset, digest('anything'), listed).ok).toBe(false)
    }
  })

  it("a release's list gives an app no screens", () => {
    put(SUMS, listing('crewbox-linux-x64-v1.2.0') + listing('Crewbox-v1.2.0.dmg'))
    put(SIGNATURE, 'c2lnbmF0dXJl\n')
    expect(() => checkSums(dist)).toThrow(`${INFO} is not in ${SUMS}`)
  })
})

describe('the command line', () => {
  const check = (dir) => execFileSync('node', [CHECK, dir], { encoding: 'utf8', stdio: 'pipe' })

  it('says the files are the ones the list names', () => {
    sign()
    put('cordova.js', '')
    expect(check(dist)).toContain(`5 files in ${dist} are the ones ${SUMS} lists`)
  })

  it('fails, saying which file, when one is not', () => {
    sign()
    put('index.html', 'changed')
    expect(refusal(() => check(dist))).toContain(
      '::error::index.html is not the file that was signed'
    )
  })
})
