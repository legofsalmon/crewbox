/**
 * What a QR code read by the apps' scanner says, for the join screen.
 *
 * A box prints one QR for crew: its address, with the event PIN when the page
 * is read on the local network (`/connect` in server/src/app.ts, and the box's
 * console at start-up). So `http://192.168.8.1/?pin=4821`, or
 * `https://chat.crew.example/` with no PIN. Scanning it is typing both.
 *
 * A QR is anybody's to print, so anything that isn't that shape is said to be
 * something else rather than tried as an address. One that is goes where a
 * typed address goes, with the same checks when Join is pressed.
 */

export type JoinCode =
  /** A box's join QR: where it is, and the event PIN when it carries one. */
  | { kind: 'join'; origin: string; pin: string }
  /** A Wi-Fi network's QR (`WIFI:S:…;;`), which a phone's own camera joins. */
  | { kind: 'wifi'; ssid: string }
  | { kind: 'other' }

/** An event PIN is 4 to 64 characters on the box (server/src/app.ts). */
const MAX_PIN = 64

/**
 * The value of one field of a `WIFI:` code, where `\` escapes `;`, `,`, `:`,
 * `"` and itself (the ZXing format both phones' cameras read). A name that
 * could be read as hex may be quoted, and the quotes are not part of it.
 */
function wifiField(body: string, key: string): string | null {
  let i = 0
  while (i < body.length) {
    // Each field is KEY:value, up to the next semicolon that isn't escaped.
    const colon = body.indexOf(':', i)
    const semicolon = body.indexOf(';', i)
    if (colon < 0) return null
    if (semicolon >= 0 && semicolon < colon) {
      i = semicolon + 1
      continue
    }
    const name = body.slice(i, colon)
    let value = ''
    let j = colon + 1
    for (; j < body.length && body[j] !== ';'; j++) {
      if (body[j] === '\\' && j + 1 < body.length) j++
      value += body[j]
    }
    if (name.trim().toUpperCase() === key) {
      return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value
    }
    i = j + 1
  }
  return null
}

/** What the text of a scanned QR code is, for the join screen. */
export function readJoinCode(text: string): JoinCode {
  const trimmed = text.trim()
  if (/^WIFI:/i.test(trimmed)) {
    return { kind: 'wifi', ssid: wifiField(trimmed.slice(5), 'S') ?? '' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { kind: 'other' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'other' }
  // The box's QR is its bare address: a page somewhere, or a login in the
  // URL, is some other code that happens to be a link.
  if (url.username || url.password || url.pathname !== '/' || url.hash) return { kind: 'other' }
  const pin = (url.searchParams.get('pin') ?? '').trim()
  if (pin.length > MAX_PIN) return { kind: 'other' }
  return { kind: 'join', origin: url.origin, pin }
}

/**
 * An event PIN as the box takes one, 4 to 64 characters once trimmed
 * (server/src/app.ts), with nothing in it a keyboard can't type; or null.
 */
function eventPin(value: string): string | null {
  const pin = value.trim()
  if (pin.length < 4 || pin.length > MAX_PIN || /\p{Cc}/u.test(pin)) return null
  return pin
}

/**
 * What a `crewbox://join` link says: the box's address as the Crew server
 * field takes it, and the event PIN, as `crewbox://join?server=192.168.8.1&pin=4821`.
 *
 * A link is anybody's to send, as a QR is anybody's to print, so it is held
 * to the same shape: a bare address, or nothing, and a PIN the box would take,
 * or none. A link that doesn't fit is refused whole rather than tidied. The
 * query is read here rather than by the web view's URL parser, which need not
 * agree with other engines about an address with a scheme of its own.
 */
export function readJoinLink(link: string): Extract<JoinCode, { kind: 'join' | 'other' }> {
  const match = /^crewbox:\/\/join\/?(?:\?([^#]*))?$/i.exec(link.trim())
  if (!match) return { kind: 'other' }
  const params = new URLSearchParams(match[1] ?? '')
  const server = (params.get('server') ?? '').trim()
  const pin = (params.get('pin') ?? '').trim()
  if (!server || (pin && !eventPin(pin))) return { kind: 'other' }
  // As the field takes it: with no scheme, plain HTTP, as on the poster.
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(server) ? server : `http://${server}`)
  } catch {
    return { kind: 'other' }
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { kind: 'other' }
  }
  return { kind: 'join', origin: url.origin, pin }
}

/**
 * The crewbox://join link for a box and its event PIN, as readJoinLink reads
 * it back: what a phone's join page offers to open the app with. The address
 * is as the Crew server field takes it, bare for plain HTTP as on the poster.
 */
export function joinLink(origin: string, pin: string): string {
  const url = new URL(origin)
  const query = new URLSearchParams({ server: url.protocol === 'https:' ? url.origin : url.host })
  // Only a PIN the box would take: half of one typed is left for the app's form.
  const valid = eventPin(pin)
  if (valid) query.set('pin', valid)
  return `crewbox://join?${query}`
}

/** The Android app, as an `intent:` link names it: its applicationId (native/android). */
const ANDROID_PACKAGE = 'com.colmhewson.crewbox'

/**
 * The same link as Chrome on Android takes it: an `intent:` URL naming the
 * app, so a phone without the app goes to `fallback` rather than nowhere
 * (developer.chrome.com/docs/android/intents). With the app, Chrome hands it
 * `crewbox://join?…` as joinLink makes it.
 */
export function androidJoinLink(origin: string, pin: string, fallback: string): string {
  const query = joinLink(origin, pin).slice('crewbox://join'.length)
  return (
    `intent://join${query}#Intent;scheme=crewbox;package=${ANDROID_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(fallback)};end`
  )
}
