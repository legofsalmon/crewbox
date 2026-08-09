// Serve site/ locally the way Vercel does — clean URLs, /docs → docs
// directory — so `npm run docs:preview` shows exactly what will deploy.
// Zero dependencies; not part of any build.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 4310)
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

createServer((req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '')
  const candidates =
    path === '/'
      ? ['index.html']
      : [path.slice(1), `${path.slice(1)}.html`, join(path.slice(1), 'index.html')]
  for (const candidate of candidates) {
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
}).listen(PORT, () => console.log(`site preview: http://localhost:${PORT}`))
