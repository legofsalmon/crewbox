#!/usr/bin/env node
// The licence notices for everything Crewbox ships that we did not write.
//
//   node scripts/third-party-notices.mjs            # rewrite web/public/third-party-notices.txt
//   node scripts/third-party-notices.mjs --check    # exit 1 if it is out of date
//
// Most of what is in a box binary, the web app and the phone apps is other
// people's code under permissive licences (MIT, ISC, BSD, Apache-2.0), and
// every one of those licences asks for the same thing: ship the copyright
// notice and the licence text with the copies. Before this file nothing did.
//
// The output lives in web/public, so it is in the web build — which is inside
// the box binary, the macOS app, the APK and the iOS app — and a running box
// serves it at /third-party-notices.txt. It is generated from package-lock.json
// and node_modules, so it is exactly what `npm ci` installs: the runtime
// dependencies of the shared, server and web workspaces and the Capacitor
// runtime of the phone apps, plus the Workbox runtime the PWA build copies
// in. It is committed, and a server test fails when it no longer matches the
// lockfile.
//
// Three things are not npm packages and are described by hand at the end: the
// Node.js runtime inside the box binary, the LiveKit server inside it, and the
// AndroidX libraries in the APK.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUTPUT = join(ROOT, 'web', 'public', 'third-party-notices.txt')

/** Workspaces whose runtime dependencies ship, and phone runtimes that do too. */
const SHIPPED_WORKSPACES = ['shared', 'server', 'web']
const SHIPPED_NATIVE = ['@capacitor/android', '@capacitor/ios', '@capacitor/core']
/**
 * Build tools of the web workspace whose runtime code is copied into the
 * output anyway: vite-plugin-pwa writes the Workbox runtime into the service
 * worker, and workbox-window into the app bundle.
 */
const BUNDLED_BY_BUILD = [
  'workbox-core',
  'workbox-expiration',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
  'workbox-window',
]

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$|^(licen[cs]e)[-_.]/i

/** Where `name` resolves from a package at `from`, the way Node would. */
function resolve(packages, from, name) {
  let dir = from
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`
    if (packages[candidate]) return candidate
    if (!dir) return null
    const cut = dir.lastIndexOf('/node_modules/')
    dir = cut === -1 ? '' : dir.slice(0, cut)
  }
}

/** Every package reachable from the shipped roots through runtime dependencies. */
export function shippedPackages(lock) {
  const packages = lock.packages
  const seen = new Set()
  const queue = []
  const visit = (from, deps) => {
    for (const name of Object.keys(deps ?? {})) {
      const at = resolve(packages, from, name)
      if (at && !seen.has(at)) {
        seen.add(at)
        queue.push(at)
      }
    }
  }
  for (const ws of SHIPPED_WORKSPACES) visit(ws, packages[ws]?.dependencies)
  visit('native', Object.fromEntries(SHIPPED_NATIVE.map((n) => [n, '*'])))
  visit('web', Object.fromEntries(BUNDLED_BY_BUILD.map((n) => [n, '*'])))
  while (queue.length) {
    const at = queue.shift()
    const info = packages[at]
    // A workspace link points at the workspace itself.
    const real = info.link ? info.resolved : at
    visit(real, packages[real]?.dependencies)
    visit(real, packages[real]?.optionalDependencies)
  }
  return [...seen]
    .map((at) => {
      const info = packages[at]
      const real = info.link ? info.resolved : at
      return { at: real, name: at.split('node_modules/').pop(), info: packages[real] ?? info }
    })
    .filter((p) => !SHIPPED_WORKSPACES.includes(p.at) && !p.name.startsWith('@crewbox/'))
    .sort((a, b) => a.name.localeCompare(b.name) || a.at.localeCompare(b.at))
}

function licenceTexts(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim())
}

function licenceName(info, dir) {
  if (typeof info.license === 'string') return info.license
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof pkg.license === 'string') return pkg.license
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  } catch {
    // Reported as unknown below.
  }
  return 'UNKNOWN'
}

const RULE = '-'.repeat(78)

const BY_HAND = `${RULE}
Node.js runtime (inside the Crewbox box binary)
Licence: MIT, with bundled components under their own licences
${RULE}
The box is a Node.js single-executable application: the Node.js runtime is
part of the binary. Node.js is Copyright Node.js contributors, under the MIT
licence. It includes components under other permissive licences, among them
V8 (BSD-3-Clause), libuv (MIT), OpenSSL (Apache-2.0), ICU (Unicode licence),
llhttp (MIT), c-ares (MIT), nghttp2 (MIT), zlib (zlib licence) and SQLite
(public domain). Their full notices are Node's LICENSE file, published with
every Node.js release at https://github.com/nodejs/node/blob/main/LICENSE for
the version the box was built with.

${RULE}
LiveKit server (inside the Crewbox box binary, runs as the voice server)
Licence: Apache-2.0
${RULE}
Copyright LiveKit, Inc. Licensed under the Apache License, Version 2.0; you
may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0. Source:
https://github.com/livekit/livekit. It is built from that source (macOS) or
taken from LiveKit's own release (Linux, Windows) unmodified, and includes Go
modules under their own permissive licences (listed in its go.mod).

${RULE}
AndroidX libraries (in the Android app)
Licence: Apache-2.0
${RULE}
Copyright The Android Open Source Project. Licensed under the Apache License,
Version 2.0; you may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0.
`

export function renderNotices(
  lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
) {
  const shipped = shippedPackages(lock)
  const header = `THIRD-PARTY NOTICES — Crewbox

Crewbox includes the software listed below, written by others and used under
their licences. Each entry gives the package, its version, its licence and
the licence text and notices it ships with. Generated from package-lock.json
by scripts/third-party-notices.mjs; do not edit by hand.

${shipped.length} npm packages, then the Node.js runtime, the LiveKit server and AndroidX.
`
  const blocks = shipped.map(({ at, name, info }) => {
    const dir = join(ROOT, at)
    const texts = licenceTexts(dir)
    return [
      RULE,
      `${name} ${info.version ?? ''}`.trim(),
      `Licence: ${licenceName(info, dir)}`,
      RULE,
      texts.length
        ? texts.join('\n\n')
        : '(no licence file in the package; see its licence field above)',
      '',
    ].join('\n')
  })
  return `${header}\n${blocks.join('\n')}\n${BY_HAND}`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = renderNotices()
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
    if (current !== text) {
      console.error(
        'web/public/third-party-notices.txt is out of date: run node scripts/third-party-notices.mjs'
      )
      process.exit(1)
    }
    console.log('third-party notices are current')
  } else {
    writeFileSync(OUTPUT, text)
    console.log(`wrote ${OUTPUT}`)
  }
}
