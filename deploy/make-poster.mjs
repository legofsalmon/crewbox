// Generate printable QR join posters: node deploy/make-poster.mjs [url] [pin]
// Writes deploy/poster.html — print a stack and zip-tie them to poles.
//
// Give it the address crew will actually reach, PORT AND ALL. A box on 8787
// with no 443 redirect wants https://chat.example.com:8787 — a poster is the
// one thing on site that cannot be corrected once it is cable-tied to a pole.
// Run it where that address reaches the box: the join QR then names the
// event, and the phone apps check the box is the poster's before a PIN goes
// to it (posterEvent, below). It says so either way.
// Includes a second QR for the Android APK (served from the crew box as
// /crewbox.apk per the RUNBOOK) so phones that need lock-screen alerts can
// grab the app with no internet. The APK box only helps once an apk is
// actually deployed into the data directory — the RUNBOOK step, not this one.
import { writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import QRCode from 'qrcode'

/**
 * The two URLs the poster carries.
 *
 * Both are the address the operator gave, unchanged. The APK link used to
 * rewrite `https:` to `http:` — "Android's installer doesn't care" — but the
 * box does: a crewbox with a certificate serves TLS on that port and nothing
 * else, so the plain-http QR was a connection refused. And on a box running
 * the captive-probe responder, port 80 *is* answered — by a redirect to the
 * app root that drops the path, so the APK QR quietly landed on the join
 * page instead. A phone that has just joined the Wi-Fi and scanned the big
 * QR has already trusted this certificate; the small one can use it too.
 *
 * The port is part of the address. A box listening on 8787 needs
 * `https://chat.example.com:8787` here, or both QRs point at a port nothing
 * is on — which is the one failure a printed poster cannot be talked out of.
 */
export function posterUrls(url, pin, event) {
  const base = url.replace(/\/+$/, '')
  // The event and its key, when the box proved them, as the box's own QR
  // carries them (server/src/joinCode.ts).
  const named = event
    ? `&event=${encodeURIComponent(event.id)}&key=${encodeURIComponent(event.key)}`
    : ''
  return {
    // The join QR carries ?pin= so scanning prefills the form — the PIN is
    // printed on this same poster anyway.
    join: `${base}/?pin=${encodeURIComponent(pin)}${named}`,
    apk: `${base}/crewbox.apk`,
  }
}

/** What every statement a box signs starts with (server/src/identity.ts). */
const CONTEXT = 'crewbox-identity-v1'

/**
 * The event the join QR names, so the phone apps check the box at the
 * poster's address before a PIN goes to it (docs/DISCOVERY.md, "The join
 * QR"), or why it names none.
 *
 * Asked of the box at that address as the apps will ask it: its event and key
 * from /api/config, then a signature for the address over a fresh challenge.
 * The event goes on the poster only where the apps won't refuse the box for
 * it: it signed (`signed`), or it won't sign by a name, which a box does
 * without a certificate for that name, and the apps check the sign-in instead.
 * At an IP address a box won't sign for, as a port forward's, the apps refuse
 * a poster naming its event, so the poster names none, and joins as posters
 * printed before the QR named the event do: unchecked.
 */
export async function posterEvent(url, { fetch = globalThis.fetch } = {}) {
  const base = url.replace(/\/+$/, '')
  const { host, hostname } = new URL(base)
  const ask = async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(6000) })
    return {
      status: res.status,
      body: res.ok ? await res.json().catch(() => undefined) : undefined,
    }
  }
  let config
  try {
    config = await ask('/api/config')
  } catch (err) {
    return { why: `nothing answered at ${base} (${err?.cause?.message ?? err?.message ?? err})` }
  }
  const id = config.body?.eventId
  const key = config.body?.eventKey
  if (
    typeof id !== 'string' ||
    !/^[0-9A-Za-z_]{1,64}$/.test(id) ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9_-]{87}$/.test(key)
  ) {
    return {
      why: `what answered at ${host} gives no event key: a box from before this version, or not a box`,
    }
  }
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  let proof
  try {
    proof = await ask(`/api/identity?nonce=${nonce}`)
  } catch (err) {
    return { why: `nothing answered at ${base} (${err?.cause?.message ?? err?.message ?? err})` }
  }
  if (proof.status === 421 && !isIP(hostname.replace(/^\[(.*)\]$/, '$1'))) {
    return { event: { id, key }, signed: false }
  }
  if (proof.status === 421) {
    return {
      why:
        `the box won't sign for ${host}, which isn't its own address, as a port forward's is, ` +
        'and the phone apps refuse a poster naming its event at an address its box won’t sign for',
    }
  }
  if (proof.status !== 200) {
    return { why: `the box at ${host} didn't answer the check (HTTP ${proof.status})` }
  }
  // Over the event /api/config named, so a signature for any other fails.
  const statement = `${CONTEXT}\n${id}\n${host}\n${nonce}`
  if (!(await verifies(key, statement, proof.body?.signature))) {
    return { why: `what answered at ${host} didn't prove it runs the event it names` }
  }
  return { event: { id, key }, signed: true }
}

/** Whether `signature` is `key`'s over `statement`, as the apps check it. */
async function verifies(key, statement, signature) {
  if (typeof signature !== 'string') return false
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      Buffer.from(key, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(statement)
    )
  } catch {
    return false
  }
}

async function main() {
  const url = process.argv[2] ?? 'https://chat.example.com'
  const pin = process.argv[3] ?? 'SET-EVENT-PIN'
  const { event, signed, why } = await posterEvent(url)
  const { join: joinUrl, apk: apkUrl } = posterUrls(url, pin, event)
  const qr = await QRCode.toDataURL(joinUrl, { width: 480, margin: 1 })
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
  const at = new URL(url).host
  if (signed) {
    console.log(
      `The join QR names the event, so the phone apps check the box at ${at} is its box` +
        ' before a PIN goes to it.'
    )
  } else if (event) {
    console.log(
      `The join QR names the event. The box won't sign for ${at} without a certificate for` +
        ' that name, so the phone apps check the event it signs them in to instead, once the' +
        ' PINs have gone.'
    )
  } else {
    console.log(
      `note: the join QR names no event: ${why}. The phone apps join from it without` +
        ` checking the box first, as from an address typed in. Run this where ${url} reaches` +
        ' the box for a poster they check.'
    )
  }
  if (!/:\d+(\/|$)/.test(url)) {
    console.log(
      `note: ${url} carries no port, so both QRs point at ${url.startsWith('https:') ? 443 : 80}.` +
        ' Check that is where the box answers from a phone before printing a stack.'
    )
  }
}

// Only when run as the script, so importing posterUrls for a test does not
// write a poster and read someone else's argv.
if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) await main()
