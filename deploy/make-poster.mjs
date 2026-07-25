// Generate printable QR join posters: node deploy/make-poster.mjs [url] [pin]
// Writes deploy/poster.html — print a stack and zip-tie them to poles.
// Includes a second QR for the Android APK (served from the crew box as
// /crewbox.apk per the RUNBOOK) so phones that need lock-screen alerts can
// grab the app with no internet. The APK box only helps once crewbox.apk is
// actually deployed next to the web dist — the RUNBOOK step, not this one.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'

const url = process.argv[2] ?? 'https://chat.example.com'
const pin = process.argv[3] ?? 'SET-EVENT-PIN'
// APK downloads skip TLS on purpose: Android's installer doesn't care, and
// http avoids any cert-trust hiccup on a phone that just joined the Wi-Fi.
const apkUrl = `${url.replace(/^https:/, 'http:').replace(/\/$/, '')}/crewbox.apk`
const qr = await QRCode.toDataURL(url, { width: 480, margin: 1 })
const apkQr = await QRCode.toDataURL(apkUrl, { width: 240, margin: 1 })

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Crewbox join poster</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .poster { text-align: center; padding: 40px; page-break-after: always; }
  h1 { font-size: 64px; margin: 0 0 8px; letter-spacing: 0.05em; }
  p { font-size: 24px; margin: 6px 0; }
  .pin { font-size: 48px; font-weight: 800; border: 4px solid #000; border-radius: 16px; display: inline-block; padding: 8px 32px; margin-top: 12px; }
  img.join { width: 420px; height: 420px; }
  .url { font-size: 20px; color: #444; }
  .apk { margin-top: 28px; padding-top: 20px; border-top: 2px dashed #999; display: flex; align-items: center; justify-content: center; gap: 20px; text-align: left; }
  .apk img { width: 150px; height: 150px; }
  .apk h2 { font-size: 24px; margin: 0 0 4px; }
  .apk p { font-size: 17px; margin: 3px 0; color: #333; }
  .apk .note { font-size: 14px; color: #666; }
</style></head><body>
  <div class="poster">
    <h1>CREW CHAT</h1>
    <p>1. Join the crew Wi-Fi &nbsp; 2. Scan &nbsp; 3. Pick a name</p>
    <img class="join" src="${qr}" alt="QR code to join">
    <p class="url">${url}</p>
    <p>Event PIN</p>
    <div class="pin">${pin}</div>
    <div class="apk">
      <img src="${apkQr}" alt="QR code for the Android app">
      <div>
        <h2>Android? Get the app</h2>
        <p>Buzzes you even when your phone is locked.</p>
        <p class="note">Scan, allow the install when asked, then join as usual.<br>iPhone: use the big QR — add to Home Screen from Safari.</p>
      </div>
    </div>
  </div>
</body></html>`

const out = join(dirname(fileURLToPath(import.meta.url)), 'poster.html')
await writeFile(out, html)
console.log(`wrote ${out} for ${url} (PIN ${pin}, APK ${apkUrl})`)
