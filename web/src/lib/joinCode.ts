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
