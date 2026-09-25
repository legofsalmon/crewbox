import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES, fixtures, render } from '../../scripts/screens-fixtures.mjs'
import {
  INFO,
  KIND,
  LIMITS,
  LINE_PATTERN,
  MAX_VERSION_LENGTH,
  SEGMENT_PATTERN,
  SIGNATURE,
  SUMS,
  VERSION_PATTERN,
  atOrAbove,
  isVersion,
  judge,
  parseInfo,
  parseOffer,
  parseSums,
  signedBy,
  strictBase64,
} from '../../scripts/web-sums.mjs'
import { TRUSTED_KEYS } from '../src/update/verify.ts'

/**
 * What a phone does with a box's screens before it runs any of them, from
 * the release's side.
 *
 * Three pieces of code make those decisions: the release's rules
 * (scripts/web-sums.mjs), the Android app's Screens.java and the iPhone app's
 * ScreensPlugin.swift. A case they disagree on is screens a release signs and
 * a phone refuses, or one phone runs and the other doesn't. So the cases are
 * written once, with their answers (scripts/screens-fixtures.mjs), and run
 * here against the release's rules and in the Android app's JVM tests
 * (ScreensFixturesTest). The iPhone app has no test target yet, so what can
 * be read from its source is held to the rest here: its names, limits,
 * patterns and keys.
 */

const read = (path) => readFileSync(join(import.meta.dirname, '..', '..', path), 'utf8')
const withoutComments = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
const withoutCommentLines = (code) => code.replace(/^\s*\/\/.*$/gm, '')

const JAVA = read('native/android/app/src/main/java/com/colmhewson/crewbox/Screens.java')
const PLUGIN = read('native/android/app/src/main/java/com/colmhewson/crewbox/ScreensPlugin.java')
const SWIFT = read('native/ios/App/App/ScreensPlugin.swift')

/** A Java constant: its string literals joined and unescaped, or its number worked out. */
function java(name) {
  const at = new RegExp(`static final (?:String|int|long) ${name} =([^;]*);`).exec(JAVA)
  if (!at) throw new Error(`Screens.java has no ${name}`)
  const strings = [...at[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
  if (strings.length) return strings.map(([, text]) => text.replace(/\\(.)/g, '$1')).join('')
  return product(at[1])
}

/** A Swift constant: its raw string, its string or strings, or its number worked out. */
function swift(name) {
  const at = new RegExp(`static let ${name} =[ \\t]*(.*)`).exec(SWIFT)
  if (!at) throw new Error(`ScreensPlugin.swift has no ${name}`)
  const from = at.index + at[0].length - at[1].length
  let text = at[1]
  // A value on the next line, or a list over several.
  if (!text.trim()) text = SWIFT.slice(from + 1).split('\n')[0]
  if (text.trim().startsWith('[')) text = SWIFT.slice(from, SWIFT.indexOf(']', from) + 1)
  const raw = /#"(.*)"#/.exec(text)
  if (raw) return raw[1]
  const strings = [...withoutCommentLines(text).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
    ([, value]) => value
  )
  if (text.trim().startsWith('[')) return strings
  return strings.length ? strings[0] : product(text)
}

/** `64 * 1024` or `50L * 1024 * 1024`: the only arithmetic the constants held here use. */
function product(text) {
  return text
    .trim()
    .split('*')
    .map((factor) => factor.trim().replace(/L$/, ''))
    .reduce((total, factor) => {
      if (/^[0-9]+$/.test(factor)) return total * Number(factor)
      throw new Error(`can't work out ${text}`)
    }, 1)
}

/** Java's TRUSTED_KEYS, in order. A key's base64 can hold `//`, so only whole comment lines go. */
const javaKeys = () =>
  [...withoutCommentLines(/TRUSTED_KEYS = \{([^}]*)\}/.exec(JAVA)[1]).matchAll(/"([^"]+)"/g)].map(
    ([, key]) => key
  )

/** The release keys the box trusts, as the 32 raw bytes of each, in base64. */
const releaseKeys = () =>
  TRUSTED_KEYS.map((pem) =>
    Buffer.from(createPublicKey(pem).export({ format: 'jwk' }).x, 'base64url').toString('base64')
  )

describe('the cases a phone’s check is held to', () => {
  const cases = fixtures()

  it('are what scripts/screens-fixtures.mjs writes', () => {
    // Run `node scripts/screens-fixtures.mjs` after changing a case.
    expect(readFileSync(FIXTURES, 'utf8')).toBe(render())
  })

  it.each(cases.signatures.map((each) => [each.name, each]))(
    'find which key signed a list: %s',
    (_, { keys, sums, signature, keyIndex }) => {
      expect(signedBy(sums, signature, keys)).toBe(keyIndex)
    }
  )

  it.each(cases.lists.map((each) => [each.name, each]))('read a list: %s', (_, each) => {
    if (each.refused) {
      expect(() => parseSums(each.sums)).toThrow()
      return
    }
    // In the order listed, which is the order a phone fetches them in.
    expect([...parseSums(each.sums)]).toEqual(Object.entries(each.files))
  })

  it.each(cases.infos.map((each) => [each.name, each]))('read crewbox-web.json: %s', (_, each) => {
    if (each.refused) {
      expect(() => parseInfo(each.text)).toThrow()
      return
    }
    const info = parseInfo(each.text)
    expect({
      version: info.version,
      protocol: info.protocol,
      needs: info.nativeApi.needs,
      builtFor: info.nativeApi.builtFor,
    }).toEqual(each.info)
  })

  it.each(cases.offers.map((each) => [each.name, each]))('read a box’s answer: %s', (_, each) => {
    if (each.refused) {
      expect(() => parseOffer(each.text)).toThrow()
      return
    }
    expect(parseOffer(each.text)).toEqual(each.offer)
  })

  it('know a version when they see one', () => {
    for (const { version, valid } of cases.versions) expect(isVersion(version), version).toBe(valid)
  })

  it('compare a version with a floor', () => {
    for (const { version, floor, atOrAbove: expected } of cases.floors) {
      expect(atOrAbove(version, floor), `${version} against ${floor}`).toBe(expected)
    }
  })

  it.each(cases.judgements.map((each) => [each.name, each]))('judge screens: %s', (_, each) => {
    const { version, needs, builtFor } = each.info
    const verdict = judge({ version, nativeApi: { needs, builtFor } }, each.version, each.app)
    if (each.answer === 'ready') {
      expect(verdict).toBeNull()
      return
    }
    expect(verdict?.answer).toBe(each.answer)
    expect(verdict?.update).toBe(each.update)
  })

  it('decode only strict base64', () => {
    for (const { text, hex } of cases.base64) {
      expect(strictBase64(text)?.toString('hex') ?? null, JSON.stringify(text)).toBe(hex)
    }
  })
})

describe('the apps’ copies of the release’s rules', () => {
  it('go by the names a release writes', () => {
    for (const [javaName, swiftName, value] of [
      ['SUMS', 'sums', SUMS],
      ['SIGNATURE', 'signature', SIGNATURE],
      ['INFO', 'info', INFO],
      ['KIND', 'kind', KIND],
    ]) {
      expect(java(javaName), javaName).toBe(value)
      expect(swift(swiftName), swiftName).toBe(value)
    }
  })

  it('ask the box where it answers', () => {
    // server/src/app.ts serves GET /api/app/screens.
    expect(read('server/src/app.ts')).toContain("fastify.get('/api/app/screens'")
    expect(java('OFFER')).toBe('api/app/screens')
    expect(swift('offer')).toBe('api/app/screens')
  })

  it('take no more than the release lets a list be', () => {
    expect(java('MAX_SUMS_BYTES')).toBe(LIMITS.sumsBytes)
    expect(java('MAX_FILES')).toBe(LIMITS.files)
    expect(java('MAX_BYTES')).toBe(LIMITS.bytes)
    expect(swift('maxSumsBytes')).toBe(LIMITS.sumsBytes)
    expect(swift('maxFiles')).toBe(LIMITS.files)
    expect(swift('maxBytes')).toBe(LIMITS.bytes)
  })

  it('read versions, paths and lines with the release’s patterns', () => {
    expect(java('VERSION_PATTERN')).toBe(VERSION_PATTERN)
    expect(swift('versionPattern')).toBe(VERSION_PATTERN)
    expect(java('MAX_VERSION_LENGTH')).toBe(MAX_VERSION_LENGTH)
    expect(swift('maxVersionLength')).toBe(MAX_VERSION_LENGTH)
    expect(java('SEGMENT_PATTERN')).toBe(SEGMENT_PATTERN)
    expect(swift('segmentPattern')).toBe(SEGMENT_PATTERN)
    // The iPhone reads each line by hand (parseSums): 64 digits of lower-case
    // hex, two spaces and a path the segment pattern takes.
    expect(java('LINE_PATTERN')).toBe(LINE_PATTERN)
    expect(java('ORIGIN_PATTERN')).toBe(swift('originPattern'))
  })

  it('trust exactly the keys a box trusts, in the same order', () => {
    // A key the apps lack makes every screen it signs "unsigned" on phones;
    // one they have that the release doesn't is a key nobody meant to trust.
    const keys = releaseKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect(javaKeys()).toEqual(keys)
    expect(swift('trustedKeys')).toEqual(keys)
  })

  it('keep the native contract the screens they came with were built for', () => {
    const nativeApi = read('web/src/lib/nativeApi.ts')
    const [, needs, builtFor] = /SCREENS_NATIVE_API = \{ needs: (\d+), builtFor: (\d+) \}/.exec(
      nativeApi
    )
    // Raised together: the screens a build carries are written against the
    // contract its native code keeps.
    expect(java('NATIVE_API')).toBe(Number(builtFor))
    expect(swift('nativeApi')).toBe(Number(builtFor))
    expect(Number(needs)).toBeLessThanOrEqual(java('NATIVE_API'))
    expect(java('OLDEST_SCREENS_API')).toBeLessThanOrEqual(java('NATIVE_API'))
    expect(swift('oldestScreensApi')).toBe(java('OLDEST_SCREENS_API'))
  })

  it('run the screens of this release and later, and so do both', () => {
    const floor = java('FLOOR')
    expect(floor).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/)
    expect(swift('floor')).toBe(floor)
    const { version } = JSON.parse(read('package.json'))
    expect(atOrAbove(`${version}+commit`, floor)).toBe(true)
  })
})

describe('where the apps keep what they fetch', () => {
  it('is a folder that backups leave out, under a name that reaches phones', () => {
    expect(java('FOLDER')).toBe('crewbox-screens')
    expect(swift('folder')).toBe('crewbox-screens')
    // Android leaves getNoBackupFilesDir() out of backups and transfers.
    expect(withoutComments(PLUGIN)).toContain(
      'new File(getContext().getNoBackupFilesDir(), Screens.FOLDER)'
    )
    // Not Caches, which iOS empties when it likes, and marked on the folder.
    const code = withoutComments(SWIFT)
    expect(code).toContain('for: .applicationSupportDirectory')
    expect(code).not.toContain('.cachesDirectory')
    expect(code).toMatch(
      /values\.isExcludedFromBackup = true\s*try root\.setResourceValues\(values\)/
    )
  })

  it('is fetched from the box it was asked of, and nowhere a redirect points', () => {
    const plugin = withoutComments(PLUGIN)
    expect(plugin).toContain('.followRedirects(false)')
    expect(plugin).toContain('.followSslRedirects(false)')
    expect(withoutComments(SWIFT)).toMatch(
      /willPerformHTTPRedirection[^{]*\{\s*completionHandler\(nil\)\s*\}/
    )
  })
})

describe('the iPhone app’s plugin', () => {
  it('is registered on the bridge, built, and goes by the name the page looks for', () => {
    expect(read('native/ios/App/App/CrewboxViewController.swift')).toContain(
      'bridge?.registerPluginInstance(ScreensPlugin())'
    )
    expect(read('native/ios/App/App.xcodeproj/project.pbxproj')).toContain(
      '/* ScreensPlugin.swift in Sources */,'
    )
    expect(SWIFT).toContain('public let jsName = "CrewboxScreens"')
    expect(read('web/src/lib/server.ts')).toContain('Plugins?.CrewboxScreens')
  })
})
