#!/usr/bin/env node
// Rebuild st2110/pkg, the ST 2110 checks compiled to WebAssembly, from a
// checkout of https://github.com/legofsalmon/st2110, and st2110/NOTICES.txt,
// the licences of the Rust crates compiled into it.
//
//   node scripts/build-st2110.mjs ../st2110
//
// The checks (SDP files, PTP messages, NMOS registries, packet captures) are
// written once, in Rust, in that repository, and this is how crewbox takes
// them: one WebAssembly module that the box runs under Node and the Network
// page runs in the browser. The output is committed, like the docs site, so
// neither CI nor anyone building a box needs a Rust toolchain. Rebuilding it
// does: Rust with the wasm32-unknown-unknown target, and the wasm-bindgen CLI
// at the version st2110's Cargo.lock names (`cargo install wasm-bindgen-cli
// --version <it> --locked`). The glue it writes must match the library
// compiled into the module, so a mismatch is refused rather than shipped.
//
// The checkout must be clean: the commit it was built from goes into
// st2110/package.json, and a commit is only a true account of a clean tree.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = join(ROOT, 'st2110')
const OUT = join(PACKAGE, 'pkg')
const TARGET = 'wasm32-unknown-unknown'
const RULE = '-'.repeat(78)

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

function fail(message) {
  console.error(message)
  process.exit(1)
}

const source = resolve(process.argv[2] ?? process.env.ST2110_DIR ?? '')
if (!process.argv[2] && !process.env.ST2110_DIR) {
  fail('usage: node scripts/build-st2110.mjs <path to a legofsalmon/st2110 checkout>')
}
if (!existsSync(join(source, 'crates', 'wasm', 'Cargo.toml'))) {
  fail(`${source} is not a checkout of legofsalmon/st2110 (no crates/wasm)`)
}
if (run('git', ['status', '--porcelain'], source).trim()) {
  fail(`${source} has uncommitted changes; build from a commit`)
}
const commit = run('git', ['rev-parse', 'HEAD'], source).trim()

const metadata = JSON.parse(
  run(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET],
    source
  )
)
const bindgen = metadata.packages.find((p) => p.name === 'wasm-bindgen')?.version
const cli = run('wasm-bindgen', ['--version']).trim().split(/\s+/).pop()
if (!bindgen || cli !== bindgen) {
  fail(
    `st2110's Cargo.lock has wasm-bindgen ${bindgen ?? '(none)'} but the CLI is ${cli}: ` +
      `cargo install wasm-bindgen-cli --version ${bindgen} --locked`
  )
}

console.log(`building st2110-wasm at ${commit.slice(0, 12)}`)
execFileSync('cargo', ['build', '-p', 'st2110-wasm', '--release', '--target', TARGET, '--locked'], {
  cwd: source,
  stdio: 'inherit',
})

rmSync(OUT, { recursive: true, force: true })
execFileSync(
  'wasm-bindgen',
  [
    '--target',
    'web',
    // Names and producer strings are for debuggers and cost a phone about a
    // tenth of the download; the module never panics on input it is given.
    '--remove-name-section',
    '--remove-producers-section',
    '--out-dir',
    OUT,
    '--out-name',
    'st2110_wasm',
    join(metadata.target_directory, TARGET, 'release', 'st2110_wasm.wasm'),
  ],
  { stdio: 'inherit' }
)

// --- The notices ------------------------------------------------------------
//
// Only what is compiled into the module: the normal dependencies of
// st2110-wasm for the WebAssembly target, without proc-macros, which run in
// the compiler and leave nothing of their own behind. st2110's own crates are
// the licensor's, as crewbox is, and are left out like crewbox's workspaces.
const tree = run(
  'cargo',
  [
    'tree',
    '-p',
    'st2110-wasm',
    '--target',
    TARGET,
    '-e',
    'normal,no-proc-macro',
    '--prefix',
    'none',
    '--format',
    '{p}',
    '--locked',
  ],
  source
)
const shipped = [
  ...new Set(
    tree
      .split('\n')
      .map((line) => line.replace(/ \(\*\)$/, '').trim())
      .filter(Boolean)
  ),
]
  .map((line) => {
    const [name, version] = line.split(' ')
    return { name, version: version.replace(/^v/, '') }
  })
  .filter(({ name }) => !name.startsWith('st2110-'))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-_.].*)?$/i

/**
 * The licence files a crate's notice carries. Where a crate offers MIT as an
 * alternative (almost all of them: "MIT OR Apache-2.0"), crewbox takes it
 * under MIT, so the MIT text and copyright go with it and the Apache-2.0 and
 * Unlicense texts, which were only the other choice, do not. A licence joined
 * with AND (unicode-ident's Unicode-3.0) is not a choice and stays.
 */
function noticeFiles(dir, licence) {
  const files = readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
  const choseMit = /\bMIT\b/.test(licence) && /\bOR\b/.test(licence)
  return choseMit ? files.filter((f) => !/apache|unlicense/i.test(f)) : files
}

const blocks = shipped.map(({ name, version }) => {
  const pkg = metadata.packages.find((p) => p.name === name && p.version === version)
  if (!pkg) fail(`cargo metadata has no ${name} ${version}`)
  const licence = pkg.license ?? 'UNKNOWN'
  const dir = dirname(pkg.manifest_path)
  const texts = noticeFiles(dir, licence).map((f) =>
    readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()
  )
  if (texts.length === 0) fail(`${name} ${version} ships no licence file to carry`)
  return [
    RULE,
    `${name} ${version} (Rust crate)`,
    `Licence: ${licence}`,
    RULE,
    texts.join('\n\n'),
    '',
  ].join('\n')
})

writeFileSync(
  join(PACKAGE, 'NOTICES.txt'),
  `The Rust crates compiled into st2110/pkg/st2110_wasm_bg.wasm, built from
legofsalmon/st2110 at commit
${commit}.
Generated by scripts/build-st2110.mjs; do not edit by hand. Where a crate
offers MIT as an alternative, it is used under MIT.

${blocks.join('\n')}`
)

const manifestPath = join(PACKAGE, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.st2110 = { commit, wasmBindgen: bindgen }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`st2110/pkg rebuilt from ${commit}, with notices for ${shipped.length} crates`)
