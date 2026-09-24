import type { WifiNetwork } from './server.ts'

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
  /** A Wi-Fi network's QR (`WIFI:S:…;;`), as a phone's camera reads it. */
  | WifiCode
  | { kind: 'other' }

/**
 * How a Wi-Fi code says its network is secured, from its `T:` field: `wpa`
 * for WPA2 or WPA3 personal (`WPA`, which covers both), `wpa3` where the code
 * says WPA3 alone (`SAE`), and `other` for WEP, enterprise networks and
 * anything else, which the apps leave to the phone's own Wi-Fi settings.
 */
export type WifiSecurity = 'open' | 'wpa' | 'wpa3' | 'other'

export interface WifiCode {
  kind: 'wifi'
  /** The network's name, '' when the code has none. */
  ssid: string
  /** '' for none. A code for an open network may carry one, which is ignored. */
  password: string
  security: WifiSecurity
  /** `H:true`: a network that doesn't broadcast its name. */
  hidden: boolean
}

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
    let escaped = false
    let j = colon + 1
    for (; j < body.length && body[j] !== ';'; j++) {
      escaped = body[j] === '\\' && j + 1 < body.length
      if (escaped) j++
      value += body[j]
    }
    if (name.trim().toUpperCase() === key) {
      // Quotes around a value only mark it as text, a name that could be read
      // as hex, say. Escaped ones are part of it.
      const quoted = body[colon + 1] === '"' && value.length >= 2 && value.endsWith('"') && !escaped
      return quoted ? value.slice(1, -1) : value
    }
    i = j + 1
  }
  return null
}

/**
 * A Wi-Fi code's fields: `S` the name, `P` the password, `T` the security and
 * `H:true` for a hidden network. `E`, an EAP method, makes it enterprise,
 * whatever `T` says. With no `T` the format means an open network, but a code
 * that carries a password is taken to want it.
 *
 * `T` is read as Android's own scanner reads it: `SAE` is WPA3 alone, and any
 * `WPA`, WPA3 included, is a WPA2 password, which is also how WPA2/WPA3
 * networks take one. `R`, WPA3's "transition disable" bits in hex, makes it
 * WPA3 alone when bit 0 is set.
 */
function readWifiCode(body: string): WifiCode {
  const type = (wifiField(body, 'T') ?? '').trim().toUpperCase()
  const given = wifiField(body, 'P') ?? ''
  const disable = (wifiField(body, 'R') ?? '').trim()
  let security: WifiSecurity
  if (type.includes('EAP') || wifiField(body, 'E') !== null) security = 'other'
  else if (type === '') security = given ? 'wpa' : 'open'
  else if (type === 'NOPASS') security = 'open'
  else if (type.startsWith('SAE')) security = 'wpa3'
  // WPA, WPA2, WPA3, WPA/WPA2, WPA2/WPA3, WPA2-PSK and the like.
  else if (type.startsWith('WPA')) security = 'wpa'
  else security = 'other'
  if (security === 'wpa' && /^[0-9a-f]+$/i.test(disable) && parseInt(disable.slice(-1), 16) & 1) {
    security = 'wpa3'
  }
  return {
    kind: 'wifi',
    ssid: wifiField(body, 'S') ?? '',
    password: security === 'open' ? '' : given,
    security,
    hidden: /^true$/i.test((wifiField(body, 'H') ?? '').trim()),
  }
}

/**
 * A WPA passphrase: 8 to 63 printable ASCII characters (IEEE 802.11i). The
 * standard's other form, the key itself in 64 hex digits, neither phone takes
 * from an app: Android's add-network screen is sent it as a passphrase, which
 * can't be 64 characters, and iOS documents 8 to 63. WPA3 alone (SAE) has no
 * 8-character floor, so it takes 1 to 63 characters.
 */
const WPA_PASSPHRASE = /^[\x20-\x7e]{8,63}$/
const WPA_KEY = /^[0-9a-f]{64}$/i
const SAE_PASSWORD = /^[\x20-\x7e]{1,63}$/

/**
 * The network in a Wi-Fi code as the apps join one, or why they won't:
 * `settings` for a network only the phone's own Wi-Fi settings join (WEP,
 * enterprise, or a WPA key in hex), and `invalid` for a name or password no
 * phone would take (a name is 1 to 32 bytes), which is said without troubling
 * the phone.
 */
export function wifiToJoin(code: WifiCode): WifiNetwork | 'settings' | 'invalid' {
  const bytes = new TextEncoder().encode(code.ssid).length
  if (bytes < 1 || bytes > 32) return 'invalid'
  if (code.security === 'other') return 'settings'
  if (code.security === 'wpa' && WPA_KEY.test(code.password)) return 'settings'
  if (code.security === 'wpa' && !WPA_PASSPHRASE.test(code.password)) return 'invalid'
  if (code.security === 'wpa3' && !SAE_PASSWORD.test(code.password)) return 'invalid'
  return {
    ssid: code.ssid,
    password: code.password,
    wpa3: code.security === 'wpa3',
    hidden: code.hidden,
  }
}

/** What the text of a scanned QR code is, for the join screen. */
export function readJoinCode(text: string): JoinCode {
  const trimmed = text.trim()
  if (/^WIFI:/i.test(trimmed)) return readWifiCode(trimmed.slice(5))
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
