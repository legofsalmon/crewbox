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
import { createHash } from 'node:crypto'
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

/**
 * A path segment a phone will write to its disk: nothing a file system or a
 * URL reads specially, and no dot first, so no `..` and nothing hidden.
 */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export const safePath = (rel) => rel.split('/').every((segment) => SEGMENT.test(segment))

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
  let info
  try {
    info = JSON.parse(readFileSync(join(dir, INFO), 'utf8'))
  } catch (err) {
    throw new Error(`${INFO} is missing or unreadable: ${err.message}`, { cause: err })
  }
  const api = info?.nativeApi
  const whole = (n) => Number.isInteger(n) && n >= 1
  if (info?.kind !== KIND) throw new Error(`${INFO} is not a ${KIND} file`)
  if (typeof info.version !== 'string' || !/^\d+\.\d+\.\d+\S*\+\S+$/.test(info.version)) {
    throw new Error(`${INFO} has no version of the form 1.2.3+commit`)
  }
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
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line)
    if (!match || !safePath(match[2])) {
      throw new Error(`unreadable line in ${SUMS}: ${line.slice(0, 80)}`)
    }
    if (listed.has(match[2])) throw new Error(`${match[2]} is listed twice in ${SUMS}`)
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
