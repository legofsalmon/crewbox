// Generate printable QR join posters: node deploy/make-poster.mjs [url] [pin]
// Writes deploy/poster.html — print a stack and zip-tie them to poles.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'

const url = process.argv[2] ?? 'https://chat.example.com'
const pin = process.argv[3] ?? 'SET-EVENT-PIN'
const qr = await QRCode.toDataURL(url, { width: 480, margin: 1 })

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Inter join poster</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .poster { text-align: center; padding: 40px; page-break-after: always; }
  h1 { font-size: 64px; margin: 0 0 8px; letter-spacing: 0.05em; }
  p { font-size: 24px; margin: 6px 0; }
  .pin { font-size: 48px; font-weight: 800; border: 4px solid #000; border-radius: 16px; display: inline-block; padding: 8px 32px; margin-top: 12px; }
  img { width: 420px; height: 420px; }
  .url { font-size: 20px; color: #444; }
</style></head><body>
  <div class="poster">
    <h1>CREW CHAT</h1>
    <p>1. Join the crew Wi-Fi &nbsp; 2. Scan &nbsp; 3. Pick a name</p>
    <img src="${qr}" alt="QR code to join">
    <p class="url">${url}</p>
    <p>Event PIN</p>
    <div class="pin">${pin}</div>
  </div>
</body></html>`

const out = join(dirname(fileURLToPath(import.meta.url)), 'poster.html')
await writeFile(out, html)
console.log(`wrote ${out} for ${url} (PIN ${pin})`)
