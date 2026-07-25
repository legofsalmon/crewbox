// Live Patch sync relay: a y-websocket server with a shared-token gate and
// attachment storage.
//
// Run it anywhere Node runs:
//   cloud:  LIVEPATCH_TOKEN=change-me PORT=1234 npm start
//   venue:  same command on a laptop; point devices at ws://<laptop-ip>:1234
// …or as the prebuilt single-file executable ("festival box" app), which
// embeds the built web app and serves everything from one process.
//
// Docs are held in memory while clients are connected; the clients' local
// IndexedDB copies are the durable source of truth and re-sync on connect.
// Attachments (lineup files) are stored on disk under DATA_DIR.
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')
const { setupWSConnection } = require('y-websocket/bin/utils')

// When compiled as a Single Executable Application, the built web app is
// embedded as assets instead of read from ../dist on disk.
let sea = null
try {
  const seaModule = require('node:sea')
  if (seaModule.isSea()) sea = seaModule
} catch {
  // Plain Node — no SEA support needed.
}
const IS_SEA = sea !== null

const PORT = Number(process.env.PORT || 1234)
const HOST = process.env.HOST || '0.0.0.0'
const TOKEN = process.env.LIVEPATCH_TOKEN || ''
// The packaged app keeps its data in the user's home dir — the executable's
// own folder may be read-only (macOS translocation, Program Files).
const DATA_DIR =
  process.env.DATA_DIR ||
  (IS_SEA ? path.join(os.homedir(), '.livepatch', 'data') : path.join(__dirname, 'data'))
const FILES_DIR = path.join(DATA_DIR, 'files')
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 25 * 1024 * 1024)

// "Box mode": also serve the built app, so one machine on the venue network
// provides everything — crew devices just browse to it. Enabled when the app
// is embedded (SEA) or found on disk (or STATIC_DIR points at it).
const DEFAULT_STATIC = path.join(__dirname, '..', 'dist')
const STATIC_DIR = IS_SEA
  ? ''
  : process.env.STATIC_DIR ||
    (fs.existsSync(path.join(DEFAULT_STATIC, 'index.html')) ? DEFAULT_STATIC : '')
const BOX_MODE = IS_SEA || STATIC_DIR !== ''

fs.mkdirSync(FILES_DIR, { recursive: true })

if (!TOKEN) {
  console.warn(
    'WARNING: LIVEPATCH_TOKEN is not set — the relay will accept any client. ' +
      'Set a token for anything beyond a trusted local network.'
  )
}

const authorized = (url) => !TOKEN || url.searchParams.get('token') === TOKEN

const FILE_ID_RE = /^[a-zA-Z0-9-]{1,64}$/

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...CORS_HEADERS, ...headers })
  res.end(body)
}

const fileMetaPath = (id) => path.join(FILES_DIR, `${id}.json`)
const fileDataPath = (id) => path.join(FILES_DIR, `${id}.bin`)

const handleFileRequest = (req, res, url, id) => {
  if (!FILE_ID_RE.test(id)) return send(res, 400, 'Bad file id\n')
  if (!authorized(url)) return send(res, 401, 'Unauthorized\n')

  if (req.method === 'PUT') {
    const name = decodeURIComponent(req.headers['x-file-name'] || 'file')
    const type = req.headers['content-type'] || 'application/octet-stream'
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > MAX_FILE_BYTES) return send(res, 413, 'File too large\n')

    const out = fs.createWriteStream(fileDataPath(id))
    let received = 0
    let aborted = false
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > MAX_FILE_BYTES && !aborted) {
        aborted = true
        out.destroy()
        fs.rm(fileDataPath(id), { force: true }, () => {})
        send(res, 413, 'File too large\n')
        req.destroy()
      }
    })
    req.pipe(out)
    out.on('finish', () => {
      if (aborted) return
      const meta = { name, type, size: received }
      fs.writeFile(fileMetaPath(id), JSON.stringify(meta), (err) => {
        if (err) return send(res, 500, 'Failed to store metadata\n')
        send(res, 200, JSON.stringify({ id, ...meta }), { 'Content-Type': 'application/json' })
      })
    })
    out.on('error', () => {
      if (!aborted) send(res, 500, 'Failed to store file\n')
    })
    return
  }

  if (req.method === 'GET') {
    fs.readFile(fileMetaPath(id), 'utf8', (err, raw) => {
      if (err) return send(res, 404, 'Not found\n')
      const meta = JSON.parse(raw)
      const stream = fs.createReadStream(fileDataPath(id))
      stream.on('error', () => send(res, 404, 'Not found\n'))
      stream.on('open', () => {
        res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': meta.type,
          'Content-Length': meta.size,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          'Cache-Control': 'private, max-age=31536000, immutable',
        })
        stream.pipe(res)
      })
    })
    return
  }

  if (req.method === 'DELETE') {
    fs.rm(fileDataPath(id), { force: true }, () => {
      fs.rm(fileMetaPath(id), { force: true }, () => send(res, 204, null))
    })
    return
  }

  send(res, 405, 'Method not allowed\n')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
}

/** Read a built-app file ('index.html', 'assets/…') from SEA assets or disk. */
const readAppFile = (relPath) => {
  if (IS_SEA) {
    try {
      return Buffer.from(sea.getAsset(`dist/${relPath}`))
    } catch {
      return null
    }
  }
  const resolved = path.normalize(path.join(STATIC_DIR, relPath))
  if (!resolved.startsWith(STATIC_DIR)) return null
  try {
    if (fs.statSync(resolved).isFile()) return fs.readFileSync(resolved)
  } catch {
    // Missing file — fall through to SPA fallback.
  }
  return null
}

// index.html gets a marker so the app knows it was served by the relay and
// defaults its sync URL to this same origin — zero configuration for crew.
let indexHtmlCache = null
const boxIndexHtml = () => {
  if (indexHtmlCache === null) {
    const raw = readAppFile('index.html').toString('utf8')
    indexHtmlCache = raw.replace('</head>', '<script>window.__LIVEPATCH_BOX__=true</script></head>')
  }
  return indexHtmlCache
}

const serveStatic = (req, res, url) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed\n')
  const pathname = decodeURIComponent(url.pathname)
  const relPath = pathname.replace(/^\/+/, '')

  if (relPath !== '' && relPath !== 'index.html') {
    const body = readAppFile(relPath)
    if (body) {
      const ext = path.extname(relPath).toLowerCase()
      // Hashed assets are immutable; the service worker and manifest must not
      // be cached so app updates propagate on next visit.
      const cacheable = relPath.startsWith('assets/')
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
  }

  // index.html and any unknown path (SPA fallback)
  const html = boxIndexHtml()
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
  res.end(req.method === 'HEAD' ? undefined : html)
}

/** Non-internal IPv4 addresses, best guesses first. */
const lanAddresses = () => {
  const addresses = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address)
    }
  }
  return addresses
}

/**
 * The address crew devices should use: how this request reached the box —
 * unless that was localhost (the box's own screen), then the LAN address.
 */
const crewUrl = (req) => {
  const host = req.headers.host || `localhost:${PORT}`
  if (/^(localhost|127\.)/i.test(host)) {
    const lan = lanAddresses()
    if (lan.length > 0) return `http://${lan[0]}:${PORT}`
  }
  return `http://${host}`
}

const serveConnect = (req, res) => {
  const target = crewUrl(req)
  const QRCode = require('qrcode-svg')
  const svg = new QRCode({ content: target, padding: 2, width: 280, height: 280, ecl: 'M' }).svg()
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect — Live Patch</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #1a1d23; color: #fff;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  p { color: #b8bec8; margin: 6px 0; }
  .qr { background: #fff; padding: 14px; border-radius: 12px; margin: 20px 0; }
  .url { font-size: 1.5rem; font-weight: 700; color: #4dabf7; word-break: break-all; }
  a.open { display: inline-block; margin-top: 18px; background: #3498db; color: #fff;
           text-decoration: none; padding: 10px 22px; border-radius: 8px; font-weight: 600; }
  ${TOKEN ? '.token { color: #ffa94d; }' : ''}
</style>
</head>
<body>
<h1>Live Patch</h1>
<p>Scan with a phone, or type the address into any browser on this network:</p>
<div class="qr">${svg}</div>
<div class="url">${target}</div>
${TOKEN ? '<p class="token">An access token is required — enter it once in ⚙ Sync settings.</p>' : ''}
<a class="open" href="/">Open Live Patch on this machine</a>
</body>
</html>`
  send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'OPTIONS') return send(res, 204, null)

  const fileMatch = url.pathname.match(/^\/files\/([^/]+)$/)
  if (fileMatch) return handleFileRequest(req, res, url, fileMatch[1])

  if (url.pathname === '/healthz') {
    return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' })
  }

  if (BOX_MODE && url.pathname === '/connect') return serveConnect(req, res)

  if (BOX_MODE) return serveStatic(req, res, url)

  send(res, 200, 'Live Patch sync relay is running\n', { 'Content-Type': 'text/plain' })
})

const wss = new WebSocketServer({ noServer: true })
wss.on('connection', setupWSConnection)

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (!authorized(url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

const openBrowser = (url) => {
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // No GUI — the console banner is enough.
  }
}

server.listen(PORT, HOST, () => {
  const interactive = Boolean(process.stdout.isTTY)
  const lan = lanAddresses()
  const primary = lan.length > 0 ? `http://${lan[0]}:${PORT}` : `http://localhost:${PORT}`

  if (BOX_MODE && interactive) {
    console.log('')
    console.log('  ██  Live Patch — festival box is running')
    console.log('')
    console.log(`  Crew devices: open  ${primary}`)
    for (const extra of lan.slice(1)) console.log(`            or  http://${extra}:${PORT}`)
    console.log('  …or scan this with a phone:')
    console.log('')
    try {
      require('qrcode-terminal').generate(primary, { small: true })
    } catch {
      // QR is a nicety; the URL above is the real instruction.
    }
    console.log(`  Big-screen version of this: ${primary}/connect`)
    if (TOKEN) console.log('  Access token is SET — crew enter it once in ⚙ Sync settings.')
    console.log(`  Sheet attachments are stored in: ${DATA_DIR}`)
    console.log('  Keep this window open during the show. Ctrl+C stops the box.')
    console.log('')
    if (!process.env.LIVEPATCH_NO_OPEN) openBrowser(`http://localhost:${PORT}/connect`)
  } else {
    console.log(
      `Live Patch relay listening on ${HOST}:${PORT} ` +
        `(token ${TOKEN ? 'set' : 'NOT set'}, app ${BOX_MODE ? 'served' : 'not served'}${IS_SEA ? ', packaged' : ''})`
    )
  }
})
