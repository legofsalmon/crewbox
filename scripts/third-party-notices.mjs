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
// The rest are not npm packages and are described by hand at the end: the
// Node.js runtime inside the box binary, the LiveKit server inside it, and in
// the APK the AndroidX libraries, OkHttp (with Okio and the Kotlin standard
// library), ZXing, Tink (with Gson, and the Protocol Buffers runtime built into
// its jar), and what AndroidX CameraX brings with it. CameraX's own
// dependencies are listed as Maven Central and Google's Maven publish them for
// the version in native/android/variables.gradle; a CameraX upgrade is the time
// to look again.
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

${RULE}
OkHttp, Okio and the Kotlin standard library (in the Android app)
Licence: Apache-2.0
${RULE}
OkHttp and Okio: Copyright Square, Inc. The Kotlin standard library:
Copyright JetBrains s.r.o. and Kotlin Programming Language contributors.
Licensed under the Apache License, Version 2.0; you may obtain a copy at
https://www.apache.org/licenses/LICENSE-2.0. The Android app uses OkHttp for
the background alerts connection to the box.

${RULE}
ZXing (in the Android app)
Licence: Apache-2.0
${RULE}
Copyright ZXing authors. Licensed under the Apache License, Version 2.0; you
may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0. Source:
https://github.com/zxing/zxing. The Android app uses its core library to read
the join poster's QR code, on the phone.

${RULE}
Tink and Gson (in the Android app)
Licence: Apache-2.0
${RULE}
Tink: Copyright Google Inc. and Google LLC. Gson: Copyright Google Inc.
Licensed under the Apache License, Version 2.0; you may obtain a copy at
https://www.apache.org/licenses/LICENSE-2.0. Source:
https://github.com/tink-crypto/tink-java and https://github.com/google/gson.
The Android app uses Tink to check the signature on the screens a box
serves, and Gson to read what the box says about them. Tink also brings the
JSR-305 and Error Prone annotations and AndroidX's annotations, listed with
CameraX and AndroidX here.

${RULE}
Protocol Buffers (in the Android app, built into Tink)
Licence: BSD-3-Clause
${RULE}
Copyright 2008 Google Inc.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
    * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Code generated by the Protocol Buffer compiler is owned by the owner
of the input file used when generating it.  This code is not
standalone and requires a support library to be linked with it.  This
support library is itself covered by the above license.

${RULE}
What AndroidX CameraX brings with it (in the Android app)
Licence: Apache-2.0
${RULE}
The Android app scans the join poster with CameraX, which is part of AndroidX
(above), as is the Media3 muxer it brings. It also brings the libraries
below, each licensed under the Apache License, Version 2.0; you may obtain a
copy at https://www.apache.org/licenses/LICENSE-2.0.

Guava, with failureaccess and listenablefuture: Copyright The Guava Authors.
Dagger: Copyright The Dagger Authors. javax.inject: Copyright The JSR-330
Expert Group. JSpecify: Copyright The JSpecify Authors. AutoValue annotations:
Copyright Google LLC. Error Prone annotations: Copyright The Error Prone
Authors. J2ObjC annotations: Copyright Google Inc. The JSR-305 annotations, as
published by FindBugs. kotlinx.coroutines and kotlinx-atomicfu: Copyright
JetBrains s.r.o. and contributors.

Jakarta Dependency Injection: produced and maintained by the Eclipse Jakarta
Dependency Injection project (https://projects.eclipse.org/projects/cdi.batch).
All content is the property of the respective authors or their employers.
Jakarta Dependency Injection is a trademark of the Eclipse Foundation.

${RULE}
Checker Framework qualifiers (in the Android app, brought by Guava)
Licence: MIT
${RULE}
Checker Framework qualifiers
Copyright 2004-present by the Checker Framework developers

MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

${RULE}
libyuv (in the Android app, built into AndroidX CameraX)
Licence: BSD-3-Clause
${RULE}
Copyright 2011 The LibYuv Project Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
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

${shipped.length} npm packages, then the Node.js runtime, the LiveKit server, AndroidX, OkHttp,
ZXing, Tink and what CameraX brings with it.
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
