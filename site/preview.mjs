// Serve site/ locally the way Vercel does — clean URLs, /docs → docs
// directory — so `npm run docs:preview` shows exactly what will deploy.
// Zero dependencies; not part of any build.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SITE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 4310)
// Loopback unless told otherwise. This served every file in site/ to every
// interface, so `npm run docs:preview` on a laptop at a venue published the
// generator, the sources and the README to the whole crew network — from a
// script whose entire job is to show one person what a deploy will look
// like.
const HOST = process.env.HOST ?? '127.0.0.1'

/**
 * What Vercel does not deploy, and so what this must not serve.
 *
 * Kept beside `.vercelignore` deliberately: a preview that shows more than
 * the deploy is not a preview. Prefixes, so `docs-src/anything` is covered
 * by the directory entry.
 */
const NOT_DEPLOYED = [
  'docs-src/',
  'build-docs.mjs',
  'build-docs.test.mjs',
  'preview.mjs',
  'README.md',
]
export const deployed = (path) => !NOT_DEPLOYED.some((p) => path === p || path.startsWith(p))
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.sh': 'text/plain',
}

function serve() {
  return createServer((req, res) => {
    const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '')
    const candidates =
      path === '/'
        ? ['index.html']
        : [path.slice(1), `${path.slice(1)}.html`, join(path.slice(1), 'index.html')]
    for (const candidate of candidates) {
      if (!deployed(candidate)) continue
      try {
        const body = readFileSync(join(SITE, candidate))
        res.writeHead(200, {
          'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream',
        })
        res.end(body)
        return
      } catch {
        // try the next shape
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
}

// Only when run as the script: importing `deployed` for a test must not
// start a web server and hang the test runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve().listen(PORT, HOST, () => console.log(`site preview: http://${HOST}:${PORT}`))
}
