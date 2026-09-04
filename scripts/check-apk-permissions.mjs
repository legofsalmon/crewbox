#!/usr/bin/env node
/**
 * What the APK actually asks a phone for.
 *
 * Two failures this catches, both of which have a history here:
 *
 *  - **A permission that went missing.** Voice was dead in the native app
 *    for every crew member on every box, because `RECORD_AUDIO` was not in
 *    the manifest: the WebView asks through getUserMedia, Capacitor forwards
 *    it to the OS, and the OS denies an undeclared permission outright with
 *    no prompt for anyone to notice. The APK built, installed and ran. The
 *    only symptom was that talkback never worked, on a build nobody can
 *    patch once it is on 40 phones in a field.
 *  - **A permission that appeared.** The manifest that ships is the merge of
 *    ours with every library's, so a dependency bump can add one without a
 *    line changing in this repo. This APK is sideloaded: the install screen
 *    lists them, to crew who are being asked to trust a file served off a
 *    box in a tent. "Why does the radio app want my location" is a question
 *    worth never having to answer.
 *
 * Reads `aapt2 dump permissions` (or `aapt dump permissions`) and compares.
 * Run as `node scripts/check-apk-permissions.mjs path/to/crewbox.apk`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Without these the app is broken in a way that installs cleanly.
 *
 * Each one is load-bearing: INTERNET to reach the box at all,
 * POST_NOTIFICATIONS for the alert a rigger sees with the phone in a pocket,
 * RECORD_AUDIO and MODIFY_AUDIO_SETTINGS for talkback, the two
 * FOREGROUND_SERVICE permissions for the alerts service to survive a 14-hour
 * show day.
 */
export const REQUIRED = [
  'android.permission.INTERNET',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
]

/**
 * Deliberate, but not essential — the install screen may show these and
 * that is fine. Anything outside REQUIRED and this list is a surprise, and
 * the whole point is to be told about surprises.
 */
export const ALLOWED_EXTRA = ['android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS']

/**
 * Permissions the build writes rather than the manifest declaring them.
 *
 * `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` is added by the
 * manifest merger for androidx.core's `registerReceiver` shim. It is
 * signature-level and scoped to this app's own package: it grants nothing
 * over the device, it guards this app's dynamically registered receivers
 * against other apps, and signature permissions are not shown on the install
 * screen. Neither ours to declare nor anything a crew member could see — but
 * it is in the built APK, so the check has to know about it or fail every
 * build. A pattern rather than a literal because the name is built from the
 * application id.
 *
 * Anything else arriving uninvited is still a failure. That is the point.
 */
export const ALLOWED_PATTERNS = [/^[\w.]+\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION$/]

/**
 * Pull the permission names out of an aapt dump.
 *
 * Deliberately tolerant about the shape: aapt and aapt2 have both printed
 * `uses-permission: name='X'` and bare `uses-permission: X` over the years,
 * and a `maxSdkVersion` attribute can follow the name. Being strict here
 * would mean a build-tools bump silently reporting an empty APK.
 */
export function permissionsIn(dump) {
  const found = new Set()
  for (const line of String(dump).split('\n')) {
    const match = /^\s*(?:optional-)?uses-permission(?:-sdk-\d+)?:\s*(?:name=)?'?([\w.]+)'?/.exec(
      line
    )
    if (match) found.add(match[1])
  }
  return [...found].sort()
}

/** What is wrong with this APK, if anything. */
export function verdict(
  found,
  { required = REQUIRED, allowed = ALLOWED_EXTRA, patterns = ALLOWED_PATTERNS } = {}
) {
  const held = new Set(found)
  const expected = new Set([...required, ...allowed])
  return {
    missing: required.filter((name) => !held.has(name)),
    unexpected: found.filter(
      (name) => !expected.has(name) && !patterns.some((pattern) => pattern.test(name))
    ),
  }
}

/**
 * The newest build-tools copy of aapt2, or aapt.
 *
 * Newest rather than first: the runner image carries several build-tools
 * versions and the oldest can predate the APK's compile SDK. Directory names
 * are `35.0.0`-shaped, so a numeric sort by component is the ordering.
 */
export function findAapt(androidHome, { list = readdirSync, exists = existsSync } = {}) {
  if (!androidHome) return null
  let versions
  try {
    versions = list(join(androidHome, 'build-tools'))
  } catch {
    // No SDK here at all. Saying so beats running something else's aapt.
    return null
  }
  const ordered = [...versions].sort((a, b) => {
    const parts = (v) => v.split('.').map((n) => Number(n) || 0)
    const [x, y] = [parts(a), parts(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
    }
    return 0
  })
  for (const version of ordered) {
    for (const tool of ['aapt2', 'aapt']) {
      const path = join(androidHome, 'build-tools', version, tool)
      if (exists(path)) return path
    }
  }
  return null
}

function main(argv) {
  const apk = argv[0]
  if (!apk) {
    console.error('usage: node scripts/check-apk-permissions.mjs <path-to.apk>')
    return 2
  }
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? ''
  const aapt = findAapt(home)
  if (!aapt) {
    console.error(`No aapt2 or aapt under ${home || '$ANDROID_HOME'}/build-tools.`)
    return 2
  }
  const dump = execFileSync(aapt, ['dump', 'permissions', apk], { encoding: 'utf8' })
  const found = permissionsIn(dump)
  const { missing, unexpected } = verdict(found)

  console.log(`${apk} asks for ${found.length} permission(s):`)
  for (const name of found) console.log(`  ${name}`)

  for (const name of missing) {
    console.error(
      `::error::${name} is missing from the built APK. The app installs and then quietly cannot do the thing that permission is for.`
    )
  }
  for (const name of unexpected) {
    console.error(
      `::error::${name} is in the built APK and was not asked for — most likely pulled in by a library's manifest. If it is meant to be there, add it to ALLOWED_EXTRA in scripts/check-apk-permissions.mjs and say why.`
    )
  }
  if (missing.length || unexpected.length) return 1
  console.log('Permissions are exactly what this app asked for.')
  return 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)))
}
