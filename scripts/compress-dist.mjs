// Precompress the built web app: write .gz and .br siblings beside every
// compressible asset in dist. @fastify/static serves them via
// `preCompressed: true`, so a phone on festival Wi-Fi downloads ~a quarter
// of the bytes — and the box's single event loop spends zero CPU on it,
// because the compression happened here, at build time, not per request.
//
// Runs as part of `npm run build -w web`. No dependencies: node:zlib only.
// Already-compact formats (png, woff2, webp) and tiny files are skipped —
// a .gz sibling that saves 40 bytes is not worth the directory entry.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const dir = process.argv[2] ?? 'dist'
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt'])
const MIN_BYTES = 1024

let files = 0
let before = 0
let after = 0

const walk = (d) => {
  for (const name of readdirSync(d)) {
    const path = join(d, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path)
      continue
    }
    // extname of "app.js.gz" is ".gz", so siblings from an earlier run are
    // never re-compressed; their originals just overwrite them below.
    if (!COMPRESSIBLE.has(extname(name)) || stat.size < MIN_BYTES) continue
    const raw = readFileSync(path)
    const gz = gzipSync(raw, { level: 9 })
    const br = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
    writeFileSync(`${path}.gz`, gz)
    writeFileSync(`${path}.br`, br)
    files += 1
    before += raw.length
    after += Math.min(gz.length, br.length)
  }
}

walk(dir)
console.log(
  `precompressed ${files} assets: ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (best encoding)`
)
