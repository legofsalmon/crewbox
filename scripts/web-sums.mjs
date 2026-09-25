#!/usr/bin/env node
/**
 * The signed list of a release's web screens, `WEBSUMS`, and its rules.
 *
 * The apps are to run the screens their box serves, not only the ones built
 * into them, and only screens a crewbox release signed: an app has one origin
 * for every event the phone has been to, so code from anywhere else could
 * read them all. So a release builds its screens once, signs this list of
 * them with the release key (scripts/sign-web.mjs), and every box and the APK
 * carries exactly those bytes (scripts/build-box.mjs, release.yml).
 *
 * The list is what `sha256sum` writes, one line per file, like the release's
 * own `SHA256SUMS`, so `sha256sum -c WEBSUMS` checks a box's screens by hand.
 * It leaves out the `.br` and `.gz` copies, which only change how a file
 * travels, and it lists `crewbox-web.json`, which says which screens these
 * are. The two lists can't stand in for each other: a box's updater looks in
 * `SHA256SUMS` for its own binary, which this never names, and an app wants
 * `crewbox-web.json`, which `SHA256SUMS` never lists.
 *
 * What a phone will refuse is refused here first (LIMITS, safePath), so a
 * release no phone would run fails where it's made.
 *
 *   node scripts/web-sums.mjs <dir>
 *
 * checks the files in <dir> against its `WEBSUMS`, as the APK's copy of the
 * screens is checked before it's packed.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

export const SUMS = 'WEBSUMS'
export const SIGNATURE = 'WEBSUMS.sig'
export const INFO = 'crewbox-web.json'
export const KIND = 'crewbox-web'

/**
 * The most a phone will take from a box: the list's size (the same 64 KB a
 * box allows `SHA256SUMS`, MAX_MANIFEST_BYTES in server/src/update/verify.ts),
 * how many files, and how many bytes in all. Today's screens are 14 files and
 * under 2 MB.
 */
export const LIMITS = Object.freeze({ sumsBytes: 64 * 1024, files: 500, bytes: 50 * 1024 * 1024 })

/*
 * The patterns below are the apps' too: Screens.java and ScreensPlugin.swift
 * carry them as text, and server/test/screensFixtures.test.mjs holds each
 * copy to these.
 */

/**
 * A path segment a phone will write to its disk: nothing a file system or a
 * URL reads specially, and no dot first, so no `..` and nothing hidden.
 */
export const SEGMENT_PATTERN = '[A-Za-z0-9_-][A-Za-z0-9._-]*'
const SEGMENT = new RegExp(`^${SEGMENT_PATTERN}$`)

export const safePath = (rel) => rel.split('/').every((segment) => SEGMENT.test(segment))

/**
 * A version as crewbox writes one: `<major>.<minor>.<patch>`, perhaps a
 * pre-release, then `+` and the commit (web/vite.config.ts,
 * server/src/version.ts). A phone keeps each version's screens in a folder
 * named after it, so nothing else gets in.
 */
export const VERSION_PATTERN =
  '(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*'
const VERSION = new RegExp(`^${VERSION_PATTERN}$`)
export const MAX_VERSION_LENGTH = 64

export const isVersion = (value) =>
  typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && VERSION.test(value)

/**
 * Whether `version` is at or above `floor`, a plain `1.2.3`, in the order
 * semver gives them: a pre-release comes before its release, and the commit
 * after the `+` counts for nothing.
 */
export function atOrAbove(version, floor) {
  const parts = (value) => /^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})(?![0-9])(-)?/.exec(value)
  const [, ...mine] = parts(version) ?? []
  const [, ...least] = parts(floor) ?? []
  if (!mine.length || !least.length) return false
  for (let i = 0; i < 3; i++) {
    const difference = Number(mine[i]) - Number(least[i])
    if (difference !== 0) return difference > 0
  }
  return mine[3] === undefined
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** How each kind of copy (scripts/compress-dist.mjs) is turned back into its file. */
const DECODE = { '.br': brotliDecompressSync, '.gz': gunzipSync }

/** The file a `.br` or `.gz` is a copy of, when that file is beside it. */
function originalOf(name, names) {
  const ext = extname(name)
  if (!(ext in DECODE)) return undefined
  const original = name.slice(0, -ext.length)
  return names.includes(original) ? original : undefined
}

/** Every file in `dir`, as a path relative to it with `/` between its parts, sorted. */
function walk(dir) {
  const found = []
  const into = (sub) => {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub === '' ? name : `${sub}/${name}`
      if (statSync(join(dir, rel)).isDirectory()) into(rel)
      else found.push(rel)
    }
  }
  into('')
  return found.sort()
}

/** What `rel` names inside a folder: its directory's entries, and its own name. */
function siblings(dir, rel) {
  const at = rel.lastIndexOf('/')
  const sub = at === -1 ? '' : rel.slice(0, at)
  return { names: readdirSync(join(dir, sub)), name: rel.slice(at + 1), sub }
}

/**
 * The files the screens are made of, sorted: everything in `dir` but the
 * list, its signature and the compressed copies.
 */
export function screensIn(dir) {
  return walk(dir).filter((rel) => {
    if (rel === SUMS || rel === SIGNATURE) return false
    const { names, name } = siblings(dir, rel)
    return originalOf(name, names) === undefined
  })
}

/**
 * Compressed copies that don't decode to their file, or don't decode at all.
 * A box sends a phone the copy, and the phone checks what it decodes to, so a
 * stale copy would be screens every phone refuses.
 */
function staleCopies(dir) {
  const stale = []
  for (const rel of walk(dir)) {
    const { names, name, sub } = siblings(dir, rel)
    const original = originalOf(name, names)
    if (original === undefined) continue
    const file = readFileSync(join(dir, sub, original))
    try {
      if (DECODE[extname(name)](readFileSync(join(dir, rel))).equals(file)) continue
    } catch {
      // Not a copy of anything, which is as stale as a copy can be.
    }
    stale.push(rel)
  }
  return stale
}

/**
 * What says which screens these are, checked as an app will: the kind, the
 * version they were built as, the protocol they speak, and the contract with
 * the apps' native code they keep (web/src/lib/nativeApi.ts).
 */
export function readInfo(dir) {
  let text
  try {
    text = readFileSync(join(dir, INFO), 'utf8')
  } catch (err) {
    throw new Error(`${INFO} is missing or unreadable: ${err.message}`, { cause: err })
  }
  return parseInfo(text)
}

/** The same, from the file's text, as a phone reads it. */
export function parseInfo(text) {
  let info
  try {
    info = JSON.parse(text)
  } catch (err) {
    throw new Error(`${INFO} is missing or unreadable: ${err.message}`, { cause: err })
  }
  const api = info?.nativeApi
  const whole = (n) => Number.isInteger(n) && n >= 1
  if (info?.kind !== KIND) throw new Error(`${INFO} is not a ${KIND} file`)
  if (!isVersion(info.version)) throw new Error(`${INFO} has no version of the form 1.2.3+commit`)
  if (!whole(info.protocol)) throw new Error(`${INFO} has no protocol`)
  if (!whole(api?.needs) || !whole(api?.builtFor) || api.needs > api.builtFor) {
    throw new Error(`${INFO} has no nativeApi with needs at or below builtFor`)
  }
  return info
}

/** Everything in these screens a phone would refuse, as sentences. Empty when there is none. */
export function problemsWith(dir, files) {
  const problems = []
  for (const rel of files) {
    if (!safePath(rel)) problems.push(`${rel} is not a name a phone will write`)
  }
  if (files.length > LIMITS.files) {
    problems.push(`${files.length} files, over the ${LIMITS.files} a phone takes`)
  }
  const bytes = files.reduce((sum, rel) => sum + statSync(join(dir, rel)).size, 0)
  if (bytes > LIMITS.bytes) problems.push(`${bytes} bytes, over the ${LIMITS.bytes} a phone takes`)
  for (const rel of staleCopies(dir)) problems.push(`${rel} doesn't decode to the file beside it`)
  return problems
}

/** The list itself: `<sha256>  <path>` per file, as `sha256sum` writes it, ending in a newline. */
export function sumsFor(dir, files) {
  return files.map((rel) => `${sha256(readFileSync(join(dir, rel)))}  ${rel}\n`).join('')
}

/** A line of the list, as `sha256sum` writes it: the digest, two spaces and the path. */
export const LINE_PATTERN = '([0-9a-f]{64}) {2}(\\S+)'
const LINE = new RegExp(`^${LINE_PATTERN}$`)

/**
 * Read a list, strictly: a line this can't read rejects the whole list, as
 * the box's own `parseManifest` does, and so will a phone.
 */
export function parseSums(text) {
  if (Buffer.byteLength(text) > LIMITS.sumsBytes) {
    throw new Error(`${SUMS} is over ${LIMITS.sumsBytes} bytes`)
  }
  if (!text.endsWith('\n')) throw new Error(`${SUMS} doesn't end in a newline`)
  const listed = new Map()
  for (const line of text.slice(0, -1).split('\n')) {
    const match = LINE.exec(line)
    if (!match || !safePath(match[2])) {
      throw new Error(`unreadable line in ${SUMS}: ${line.slice(0, 80)}`)
    }
    if (match[2] === SUMS || match[2] === SIGNATURE) {
      throw new Error(`${SUMS} lists ${match[2]}, which is no file of the screens`)
    }
    if (listed.has(match[2])) throw new Error(`${match[2]} is listed twice in ${SUMS}`)
    if (listed.size === LIMITS.files) {
      throw new Error(`${SUMS} lists over the ${LIMITS.files} files a phone takes`)
    }
    listed.set(match[2], match[1])
  }
  return listed
}

/**
 * Check the files in `dir` against its list and the list's signature being
 * there. `exact` also refuses a file the list leaves out, and anything a phone
 * would refuse: where the screens are the ones a box serves, a file nobody
 * signed would be in a browser's screens and missing from a phone's.
 */
export function checkSums(dir, { exact = false } = {}) {
  const listed = parseSums(readFileSync(join(dir, SUMS), 'utf8'))
  const problems = []
  if (!existsSync(join(dir, SIGNATURE))) problems.push(`${SIGNATURE} is missing`)
  if (!listed.has(INFO)) problems.push(`${INFO} is not in ${SUMS}`)
  for (const [rel, digest] of listed) {
    if (!existsSync(join(dir, rel))) problems.push(`${rel} is in ${SUMS} but missing`)
    else if (sha256(readFileSync(join(dir, rel))) !== digest) {
      problems.push(`${rel} is not the file that was signed`)
    }
  }
  if (exact) {
    const files = screensIn(dir)
    for (const rel of files) if (!listed.has(rel)) problems.push(`${rel} is not in ${SUMS}`)
    problems.push(...problemsWith(dir, files))
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return listed
}

/**
 * What a box built on these screens must hold to: exactly the signed files,
 * built as the version the box will say it is. An app runs a box's screens
 * only when the two agree.
 */
export function checkSignedScreens(dir, version) {
  const info = readInfo(dir)
  if (info.version !== version) {
    throw new Error(
      `the signed screens were built as ${info.version}, but this box is ${version}: every app would refuse them`
    )
  }
  return checkSums(dir, { exact: true })
}

/*
 * What a phone does with a box's screens, before it runs any of them. The
 * apps do this in their own code (Screens.java, ScreensPlugin.swift), since
 * screens can't vouch for themselves. It is written here too so that the
 * release's rules and the phones' are held to the same cases
 * (scripts/screens-fixtures.mjs), and so a stand-in for an app can do it in a
 * browser test.
 */

/** ASCII whitespace, all a phone trims from a signature. */
const trimAscii = (text) => text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '')

/** Base64 as the release writes it, padded and with nothing else in it. Null for anything else. */
export function strictBase64(text) {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
    ? Buffer.from(text, 'base64')
    : null
}

/**
 * Which of `keys` signed `sums`, or -1 when none did. Each key is an Ed25519
 * public key's 32 bytes in base64, as the apps carry the ones in
 * server/src/update/verify.ts. The signature is the text of `WEBSUMS.sig`,
 * trimmed, and must be strict base64 of 64 bytes. It is checked over the
 * list's exact bytes: a phone never reads a list and writes it out again.
 */
export function signedBy(sums, signature, keys) {
  const bytes = strictBase64(trimAscii(signature))
  if (!bytes || bytes.length !== 64) return -1
  const data = Buffer.from(sums, 'utf8')
  return keys.findIndex((raw) => {
    const x = strictBase64(raw)
    if (!x || x.length !== 32) return false
    try {
      const jwk = { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }
      return verify(null, data, createPublicKey({ key: jwk, format: 'jwk' }), bytes)
    } catch {
      return false
    }
  })
}

/**
 * What a box says about the screens it serves (`GET /api/app/screens`,
 * server/src/screens.ts): the version it runs, the list and its signature.
 * Throws on anything else, as a phone takes it as no signed screens at all.
 */
export function parseOffer(text) {
  const offer = JSON.parse(text)
  if (typeof offer?.sums !== 'string' || typeof offer.signature !== 'string') {
    throw new Error("the box's answer has no list and signature")
  }
  if (!isVersion(offer.version))
    throw new Error("the box's answer has no version of the form 1.2.3+commit")
  return { version: offer.version, sums: offer.sums, signature: offer.signature }
}

/**
 * Whether an app runs screens that say `info` (parseInfo) from a box that
 * says it runs `version`: null when it does, and otherwise what it answers
 * instead. `app` is what an app build carries: the contract with the screens
 * its native code keeps (`nativeApi`), the oldest it still honours
 * (`oldestScreensApi`), and the oldest screens it runs (`floor`).
 *
 * - Screens of another version than the box runs are refused as if unsigned:
 *   a box can't pass off one release as another.
 * - Screens that need more of the app than it has say to update the app.
 * - Screens older than the app honours, or below its floor, say to update
 *   the box.
 */
export function judge(info, version, app) {
  if (info.version !== version) {
    return { answer: 'unsigned', reason: `the box runs ${version} but serves ${info.version}` }
  }
  if (info.nativeApi.needs > app.nativeApi) return { answer: 'incompatible', update: 'app' }
  if (info.nativeApi.builtFor < app.oldestScreensApi || !atOrAbove(info.version, app.floor)) {
    return { answer: 'incompatible', update: 'box' }
  }
  return null
}

function main(args) {
  const [dir] = args
  if (!dir) {
    console.error('usage: node scripts/web-sums.mjs <dir>')
    return 2
  }
  try {
    const listed = checkSums(dir)
    console.log(`${listed.size} files in ${dir} are the ones ${SUMS} lists`)
    return 0
  } catch (err) {
    for (const line of err.message.split('\n')) console.error(`::error::${line}`)
    return 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)))
}
