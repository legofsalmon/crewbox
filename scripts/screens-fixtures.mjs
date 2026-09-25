#!/usr/bin/env node
/**
 * The cases a phone's check of a box's screens is held to, written to
 * native/android/app/src/test/resources/screens-fixtures.json.
 *
 *   node scripts/screens-fixtures.mjs
 *
 * Three pieces of code make the same decisions about the same bytes: the
 * release's rules in scripts/web-sums.mjs, the Android app's Screens.java and
 * the iPhone app's ScreensPlugin.swift. A case they disagree on is screens
 * that a release signs and a phone refuses, or one phone runs and the other
 * doesn't. So each case is written once, here, with the answer it must get,
 * and each of them is run against the file: server/test/screensFixtures.test.mjs
 * for the release's rules, and the Android app's ScreensFixturesTest. The
 * iPhone app has no test target yet.
 *
 * The answers are written by hand, not worked out by any of the three. The
 * signatures are made with keys from fixed seeds, so the file comes out the
 * same each time; the server test fails when it doesn't match what this
 * writes. No app trusts any of these keys.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FIXTURES = fileURLToPath(
  new URL('../native/android/app/src/test/resources/screens-fixtures.json', import.meta.url)
)

const sha256 = (text) => createHash('sha256').update(text).digest()

/** An Ed25519 key made from a seed: PKCS#8's fixed header, then the seed. */
function keyFrom(label) {
  const header = Buffer.from('302e020100300506032b657004220420', 'hex')
  const privateKey = createPrivateKey({
    key: Buffer.concat([header, sha256(`crewbox screens fixture key ${label}`)]),
    format: 'der',
    type: 'pkcs8',
  })
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x
  return { privateKey, raw: Buffer.from(x, 'base64url').toString('base64') }
}

const A = keyFrom('A')
const B = keyFrom('B')
const STRANGER = keyFrom('C')

const signed = (key, text) =>
  sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64')

/** One line of a list, with a made-up digest, as sha256sum writes it. */
const line = (path, digest = sha256(path).toString('hex')) => `${digest}  ${path}\n`
const list = (...paths) => paths.map((path) => line(path)).join('')
const filesOf = (...paths) =>
  Object.fromEntries(paths.map((path) => [path, sha256(path).toString('hex')]))

/** The order of the group Ed25519 signs in; S must be below it. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n

/** The same signature with S + L in place of S, which every checker must refuse. */
function malleable(signature) {
  const bytes = Buffer.from(signature, 'base64')
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32)).reverse().toString('hex')}`) + L
  const encoded = Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse()
  return Buffer.concat([bytes.subarray(0, 32), encoded]).toString('base64')
}

const SCREENS = list('crewbox-web.json', 'index.html', 'assets/index-Ab_9.js')
const BY_A = signed(A, SCREENS)

/**
 * RFC 8032, section 7.1, TEST 2, and a list shaped like crewbox's that the
 * research signed with a key of its own (phase3-ed25519.md, test vector 2):
 * signatures this file's own code had no part in.
 */
const RFC = {
  key: Buffer.from(
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    'hex'
  ).toString('base64'),
  signature: Buffer.from(
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
      '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    'hex'
  ).toString('base64'),
}
const RESEARCH = {
  key: Buffer.from(
    'cc8e06bfb5da01325bcaeb61ccff6c904772f5ddcaf562856440be029a4aa3b7',
    'hex'
  ).toString('base64'),
  sums:
    '54e7ee83cea0175729d5cdf2d6416cd090edcbfa1f1fe48c4dde804fe5c6c01d  crewbox-9.9.9.apk\n' +
    'e76d394b97377fa7a867a58e1fda5bde170515fb6f1e2ce32eec834a52318363  crewbox-web-9.9.9.tar\n',
  signature:
    'BQrlHkQxkl8dkWPDTWqSUvB4Akyp/NtYCnW/gvBIP0Z61qHizctM9gU+6XFU87WAlWHJ1jwRsfznOmRJ0EWqBA==',
  malleable:
    'BQrlHkQxkl8dkWPDTWqSUvB4Akyp/NtYCnW/gvBIP0Znqpc/6C5fTtza4BQz7ZSVlWHJ1jwRsfznOmRJ0EWqFA==',
}

function signatures() {
  const bytes = Buffer.from(BY_A, 'base64')
  const flipped = Buffer.from(SCREENS)
  flipped[10] ^= 0x01
  const cases = [
    ['signed with the first key', [A.raw, B.raw], SCREENS, `${BY_A}\n`, 0],
    ['signed with the second key', [A.raw, B.raw], SCREENS, `${signed(B, SCREENS)}\n`, 1],
    [
      "signed with a key the app doesn't trust",
      [A.raw, B.raw],
      SCREENS,
      signed(STRANGER, SCREENS),
      -1,
    ],
    ['checked against no keys at all', [], SCREENS, BY_A, -1],
    [
      "a key that isn't 32 bytes, then the one that signed",
      [A.raw.slice(0, 40), A.raw],
      SCREENS,
      BY_A,
      1,
    ],
    ['ASCII whitespace around the signature', [A.raw], SCREENS, ` \t${BY_A}\r\n`, 0],
    ['a no-break space after the signature', [A.raw], SCREENS, `${BY_A}\u00a0`, -1],
    ['a byte-order mark before the signature', [A.raw], SCREENS, `\ufeff${BY_A}`, -1],
    [
      'a line break inside the signature',
      [A.raw],
      SCREENS,
      `${BY_A.slice(0, 44)}\n${BY_A.slice(44)}`,
      -1,
    ],
    ['a signature without its padding', [A.raw], SCREENS, BY_A.replace(/=+$/, ''), -1],
    ['a signature 63 bytes long', [A.raw], SCREENS, bytes.subarray(0, 63).toString('base64'), -1],
    [
      'a signature 65 bytes long',
      [A.raw],
      SCREENS,
      Buffer.concat([bytes, Buffer.of(0)]).toString('base64'),
      -1,
    ],
    ['the signature with S + L for S', [A.raw], SCREENS, malleable(BY_A), -1],
    ['the list with CRLF line ends', [A.raw], SCREENS.replace(/\n/g, '\r\n'), BY_A, -1],
    ['the list without its last newline', [A.raw], SCREENS.slice(0, -1), BY_A, -1],
    ['the list after a byte-order mark', [A.raw], `\ufeff${SCREENS}`, BY_A, -1],
    ['the list with one bit changed', [A.raw], flipped.toString('utf8'), BY_A, -1],
    ['RFC 8032 test 2', [RFC.key], 'r', RFC.signature, 0],
    [
      'the research signature over a list like crewbox’s',
      [RESEARCH.key],
      RESEARCH.sums,
      RESEARCH.signature,
      0,
    ],
    ['that signature with S + L for S', [RESEARCH.key], RESEARCH.sums, RESEARCH.malleable, -1],
  ]
  if (malleable(RESEARCH.signature) !== RESEARCH.malleable) {
    throw new Error('the research vector and this file disagree about S + L')
  }
  return cases.map(([name, keys, sums, signature, keyIndex]) => ({
    name,
    keys,
    sums,
    signature,
    keyIndex,
  }))
}

/** Lists, and what each has in it, or that a phone refuses it. */
function lists() {
  const ok = (name, sums, files) => ({ name, sums, files })
  const refused = (name, sums) => ({ name, sums, refused: true })
  const digest = sha256('x').toString('hex')
  return [
    ok(
      'what sha256sum writes',
      SCREENS,
      filesOf('crewbox-web.json', 'index.html', 'assets/index-Ab_9.js')
    ),
    ok('files in the order listed, not sorted', list('b.js', 'a.js'), filesOf('b.js', 'a.js')),
    ok(
      'names that start with a dash or an underscore',
      list('-x.js', '_y.js'),
      filesOf('-x.js', '_y.js')
    ),
    ok('a deep path', list('a/b/c/d.js'), filesOf('a/b/c/d.js')),
    refused('an empty list', ''),
    refused('no lines', '\n'),
    refused('no newline at the end', list('index.html').slice(0, -1)),
    refused('a blank line', `${list('a.js')}\n${list('b.js')}`),
    refused('one space', `${digest} index.html\n`),
    refused('three spaces', `${digest}   index.html\n`),
    refused('a tab', `${digest}\tindex.html\n`),
    refused('a binary marker', `${digest} *index.html\n`),
    refused('a line that ends in CR', `${digest}  index.html\r\n`),
    refused('capital hex', line('index.html', digest.toUpperCase())),
    refused('a short digest', line('index.html', digest.slice(1))),
    refused('a path out of the folder', list('../index.html')),
    refused('a climb in the middle', list('a/../index.html')),
    refused('an absolute path', list('/index.html')),
    refused('a hidden file', list('.env')),
    refused('a hidden folder', list('assets/.cache/a.js')),
    refused('an empty segment', list('a//b.js')),
    refused('a trailing slash', list('assets/')),
    refused('a percent sign', list('x%20y.js')),
    refused('a backslash', list('a\\b.js')),
    refused('a name that is not ASCII', list('é.js')),
    refused('a file listed twice', list('index.html', 'index.html')),
    refused('a list that names itself', list('index.html', 'WEBSUMS')),
    refused('a list that names its signature', list('WEBSUMS.sig', 'index.html')),
  ]
}

const INFO_OK = {
  kind: 'crewbox-web',
  version: '1.2.0+abc1234',
  protocol: 1,
  nativeApi: { needs: 1, builtFor: 1 },
}
const info = (fields) => JSON.stringify({ ...INFO_OK, ...fields })

/** `crewbox-web.json` as a phone reads it, and what it says or that it's refused. */
function infos() {
  const ok = (name, text, says = {}) => ({
    name,
    text,
    info: { version: INFO_OK.version, protocol: 1, needs: 1, builtFor: 1, ...says },
  })
  const refused = (name, text) => ({ name, text, refused: true })
  const api = (nativeApi) => info({ nativeApi })
  const long = `1.2.0+${'a'.repeat(58)}`
  return [
    ok('as the web build writes it', `${JSON.stringify(INFO_OK, null, 2)}\n`),
    ok(
      'fields it has no use for',
      info({ extra: [1, 2], nativeApi: { needs: 1, builtFor: 1, later: true } })
    ),
    ok('a pre-release', info({ version: '1.2.0-rc.1+abc1234' }), { version: '1.2.0-rc.1+abc1234' }),
    ok('a version 64 characters long', info({ version: long }), { version: long }),
    ok(
      'whole numbers written with a point',
      info({ protocol: 3 }).replace('"protocol":3', '"protocol":3.0'),
      {
        protocol: 3,
      }
    ),
    ok('a newer contract than it needs', api({ needs: 2, builtFor: 5 }), { needs: 2, builtFor: 5 }),
    ok('a name given twice, the last one counting', info({}).replace('{', '{"kind":"other",')),
    refused('another kind', info({ kind: 'crewbox-box' })),
    refused('no kind', info({ kind: undefined })),
    refused('a version with no commit', info({ version: '1.2.0' })),
    refused('a version with an empty commit', info({ version: '1.2.0+' })),
    refused('a version with a v', info({ version: 'v1.2.0+abc1234' })),
    refused('a version with a leading zero', info({ version: '01.2.0+abc1234' })),
    refused('a version with two parts', info({ version: '1.2+abc1234' })),
    refused('a version with a slash', info({ version: '1.2.0+abc/../x' })),
    refused('a version with a space', info({ version: '1.2.0+abc 1234' })),
    refused('a version with an underscore', info({ version: '1.2.0+abc_1234' })),
    refused('a version with an empty part', info({ version: '1.2.0+abc..1234' })),
    refused('an empty pre-release', info({ version: '1.2.0-+abc1234' })),
    refused('a version 65 characters long', info({ version: `${long}a` })),
    refused('a version that is a number', info({ version: 1.2 })),
    refused('protocol 0', info({ protocol: 0 })),
    refused('a fraction for the protocol', info({ protocol: 1.5 })),
    refused('the protocol as text', info({ protocol: '1' })),
    refused('no protocol', info({ protocol: undefined })),
    refused('no native contract', info({ nativeApi: undefined })),
    refused('needs 0', api({ needs: 0, builtFor: 1 })),
    refused('needs over builtFor', api({ needs: 2, builtFor: 1 })),
    refused('needs as text', api({ needs: '1', builtFor: 1 })),
    refused('needs true', api({ needs: true, builtFor: 1 })),
    refused('a native contract that is a list', info({ nativeApi: [1, 1] })),
    refused(
      'needs too big to be a number',
      api({ needs: 1, builtFor: 1 }).replace('"needs":1', '"needs":1e400')
    ),
    refused('a comma after the last field', info({}).replace(/}$/, ',}')),
    refused('a comment', `/* built */${info({})}`),
    refused('single quotes', info({}).replace(/"/g, "'")),
    refused('something after it', `${info({})} and more`),
    refused('a byte-order mark before it', `\ufeff${info({})}`),
    refused('a list', `[${info({})}]`),
    refused('null', 'null'),
    refused('nothing', ''),
  ]
}

/** A box's answer to `GET /api/app/screens`, and what a phone reads from it. */
function offers() {
  const offer = { version: '1.2.0+abc1234', sums: SCREENS, signature: BY_A }
  const ok = (name, text) => ({ name, text, offer })
  const refused = (name, text) => ({ name, text, refused: true })
  const withFields = (fields) => JSON.stringify({ ...offer, ...fields })
  return [
    ok('as a box answers', JSON.stringify(offer)),
    ok('with fields it has no use for', withFields({ later: 1 })),
    refused('no list', withFields({ sums: undefined })),
    refused('no signature', withFields({ signature: undefined })),
    refused('a signature that is not text', withFields({ signature: 64 })),
    refused('no version', withFields({ version: undefined })),
    refused('a version with no commit', withFields({ version: '1.2.0' })),
    refused('a version that climbs', withFields({ version: '../../1.2.0+abc' })),
    refused('a list', `[${JSON.stringify(offer)}]`),
    refused('an error', JSON.stringify({ error: 'no signed screens on this box' })),
    refused('not JSON', '<html>'),
  ]
}

/** isVersion, beyond what the cases above cover. */
const versions = () =>
  [
    ['0.0.0+0', true],
    ['999999999.0.0+x', true],
    ['1000000000.0.0+x', false],
    ['1.0.0-alpha.1.beta+exp.sha.5114f85', true],
    ['1.0.0-al_pha+x', false],
    ['1.0.0+X-Y.z', true],
    ['1.0.0+unknown', true],
    ['1.0.0+x.', false],
    ['1.0.0+.x', false],
    ['1.0.0+x\n', false],
    [' 1.0.0+x', false],
    ['', false],
  ].map(([version, valid]) => ({ version, valid }))

/** atOrAbove: whether a version is at or above an app's floor. */
const floors = () =>
  [
    ['1.0.0+abc', '1.0.0', true],
    ['1.0.0-rc.1+abc', '1.0.0', false],
    ['1.0.1+abc', '1.0.0', true],
    ['0.9.9+abc', '1.0.0', false],
    ['1.10.0+abc', '1.9.0', true],
    ['1.9.0+abc', '1.10.0', false],
    ['2.0.0+abc', '1.99.99', true],
    ['1.2.3-beta+abc', '1.2.2', true],
    ['1.2.2-beta+abc', '1.2.2', false],
    ['1.2.3-4+abc', '1.2.3', false],
    ['1.2.3-4+abc', '1.2.2', true],
    ['x.1.0+abc', '1.0.0', false],
  ].map(([version, floor, atOrAbove]) => ({ version, floor, atOrAbove }))

/** judge: what an app does with screens it has read, from a box that says what it runs. */
function judgements() {
  const app = { nativeApi: 1, oldestScreensApi: 1, floor: '1.0.0' }
  const screens = (version, needs = 1, builtFor = 1) => ({ version, needs, builtFor })
  const cases = [
    ['screens it can run', screens('1.2.0+abc'), '1.2.0+abc', app, 'ready'],
    [
      "another version's screens than the box runs",
      screens('1.1.0+abc'),
      '1.2.0+abc',
      app,
      'unsigned',
    ],
    ['screens that need a newer app', screens('1.2.0+abc', 2, 2), '1.2.0+abc', app, 'app'],
    [
      'screens that need exactly what the app has',
      screens('1.2.0+abc', 2, 2),
      '1.2.0+abc',
      { ...app, nativeApi: 2 },
      'ready',
    ],
    [
      'screens written for a newer contract than the app has, that need no more of it',
      screens('1.2.0+abc', 1, 3),
      '1.2.0+abc',
      app,
      'ready',
    ],
    [
      'screens older than the app still honours',
      screens('1.2.0+abc', 1, 1),
      '1.2.0+abc',
      { nativeApi: 3, oldestScreensApi: 2, floor: '1.0.0' },
      'box',
    ],
    [
      'screens below the floor',
      screens('1.0.9+abc'),
      '1.0.9+abc',
      { ...app, floor: '1.1.0' },
      'box',
    ],
    [
      'a pre-release of the floor',
      screens('1.1.0-rc.2+abc'),
      '1.1.0-rc.2+abc',
      { ...app, floor: '1.1.0' },
      'box',
    ],
    [
      'screens at the floor',
      screens('1.1.0+abc'),
      '1.1.0+abc',
      { ...app, floor: '1.1.0' },
      'ready',
    ],
    [
      'screens that need a newer app and are below the floor',
      screens('1.0.0+abc', 2, 2),
      '1.0.0+abc',
      { ...app, floor: '1.1.0' },
      'app',
    ],
  ]
  return cases.map(([name, info, version, forApp, answer]) => ({
    name,
    info,
    version,
    app: forApp,
    answer: answer === 'app' || answer === 'box' ? 'incompatible' : answer,
    ...(answer === 'app' || answer === 'box' ? { update: answer } : {}),
  }))
}

/** strictBase64: bytes in hex, or null where a phone refuses the text. */
const base64 = () =>
  [
    ['', ''],
    ['QQ==', '41'],
    ['QUI=', '4142'],
    ['QUJD', '414243'],
    ['+/+/', 'fbffbf'],
    ['QR==', '41'],
    ['QQ', null],
    ['QQ=', null],
    ['Q===', null],
    ['====', null],
    ['QQ==QQ==', null],
    ['QU JD', null],
    ['QUJD\n', null],
    ['QU-_', null],
    ['QUJ-', null],
    ['QUJ_', null],
    ['QUJD!', null],
  ].map(([text, hex]) => ({ text, hex }))

export function fixtures() {
  return {
    about:
      'Written by scripts/screens-fixtures.mjs, which says what these are for. Do not edit by hand.',
    signatures: signatures(),
    lists: lists(),
    infos: infos(),
    offers: offers(),
    versions: versions(),
    floors: floors(),
    judgements: judgements(),
    base64: base64(),
  }
}

export const render = () => `${JSON.stringify(fixtures(), null, 2)}\n`

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync(FIXTURES, render())
  console.log(`wrote ${FIXTURES}`)
}
