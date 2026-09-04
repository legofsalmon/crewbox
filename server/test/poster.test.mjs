import { describe, expect, it } from 'vitest'
import { posterUrls } from '../../deploy/make-poster.mjs'

/**
 * The two QR codes on the printed poster.
 *
 * A poster is the one thing on site that cannot be corrected: it is
 * cable-tied to a pole in the dark on the Thursday and read by four hundred
 * people over the weekend. So the URLs it carries get pinned here rather
 * than trusted.
 */

describe('the URLs on a join poster', () => {
  it('prefills the PIN on the join link, because it is printed alongside anyway', () => {
    expect(posterUrls('https://chat.example.com:8787', '2468').join).toBe(
      'https://chat.example.com:8787/?pin=2468'
    )
  })

  it('escapes a PIN that is not four digits', () => {
    // The runbook tells you to make it long and rotate it once the tunnel is
    // up, and nothing stops a word with a space or an ampersand in it.
    expect(posterUrls('https://chat.example.com', 'load in&out').join).toBe(
      'https://chat.example.com/?pin=load%20in%26out'
    )
  })

  it('keeps the APK link on the same scheme and port as the join link', () => {
    // It used to rewrite https to http, on the theory that Android's
    // installer does not care about TLS. The box cares: one with a
    // certificate serves TLS on that port and nothing else, so the QR was a
    // connection refused — and on a box answering connectivity probes, port
    // 80 *is* answered, by a redirect to the app root that drops the path,
    // so the APK QR landed on the join page instead. Either way the poster
    // was wrong and nobody would find out until a crew member scanned it.
    expect(posterUrls('https://chat.example.com:8787', '2468').apk).toBe(
      'https://chat.example.com:8787/crewbox.apk'
    )
    expect(posterUrls('http://192.168.1.50:8787', '2468').apk).toBe(
      'http://192.168.1.50:8787/crewbox.apk'
    )
  })

  it('does not double the slash when the address was pasted with one', () => {
    const urls = posterUrls('https://chat.example.com:8787/', '2468')
    expect(urls.apk).toBe('https://chat.example.com:8787/crewbox.apk')
    expect(urls.join).toBe('https://chat.example.com:8787/?pin=2468')
  })
})
