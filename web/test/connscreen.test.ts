import { describe, expect, it } from 'vitest'
import { connectionCauses, connectionScreen, STUCK_AFTER_MS } from '../src/lib/connscreen.ts'

describe('connectionScreen', () => {
  it('shows chat (ok) once connected this session, regardless of connection state', () => {
    for (const connection of ['connecting', 'online', 'offline'] as const) {
      expect(connectionScreen({ connection, hasConnected: true, hasCache: false })).toBe('ok')
    }
  })

  it('shows chat (ok) for returning users with cached content, even while offline', () => {
    expect(connectionScreen({ connection: 'offline', hasConnected: false, hasCache: true })).toBe(
      'ok'
    )
  })

  it('shows the recovery screen only when offline with nothing cached', () => {
    expect(connectionScreen({ connection: 'offline', hasConnected: false, hasCache: false })).toBe(
      'unreachable'
    )
  })

  it('does not flap back to "connecting" between retries', () => {
    // A cold start with no cache retries on a backoff, so the state cycles
    // offline → connecting → offline. Without the latch the screen swapped
    // between "Can't reach the crew server" and "Connecting…" every few
    // seconds, which reads as a device that cannot make up its mind rather
    // than a box that is not there.
    expect(
      connectionScreen({
        connection: 'connecting',
        hasConnected: false,
        hasCache: false,
        hasFailed: true,
      })
    ).toBe('unreachable')
  })

  it('shows a calm connecting state during the first connect with no cache', () => {
    expect(
      connectionScreen({ connection: 'connecting', hasConnected: false, hasCache: false })
    ).toBe('connecting')
    // 'online' but pre-welcome (no cache yet) is still "connecting", not an error.
    expect(connectionScreen({ connection: 'online', hasConnected: false, hasCache: false })).toBe(
      'connecting'
    )
  })
})

describe('what to tell someone whose box has gone quiet', () => {
  it('leads with the cause the phone hides, on the phone that hides it', () => {
    // iOS reports a healthy Wi-Fi connection while routing everything past
    // it to cellular. That is invisible from inside the app and invisible in
    // the app's own diagnostics, so it has to be the first thing said — it
    // cost a real event an hour before anyone looked at the status bar.
    const causes = connectionCauses({ ssid: 'CREW-5G', isIos: true })
    expect(causes[0]?.heading).toMatch(/status bar/)
    expect(causes[0]?.body).toMatch(/mobile data/)
  })

  it('never mentions it on a platform that does not do it', () => {
    // Android keeps using the network it is joined to. A cause that cannot
    // apply is a cause that wastes the reader's time under pressure.
    const causes = connectionCauses({ ssid: 'CREW-5G', isIos: false })
    expect(causes.some((c) => /status bar|mobile data/.test(c.heading + c.body))).toBe(false)
  })

  it('names the actual network when the box has told it one', () => {
    expect(connectionCauses({ ssid: 'CREW-5G', isIos: false })[0]?.heading).toContain('CREW-5G')
  })

  it('still reads sensibly with no SSID configured', () => {
    const causes = connectionCauses({ isIos: false })
    expect(causes[0]?.heading).toContain('the crew Wi-Fi')
    expect(causes.every((c) => !c.heading.includes('undefined'))).toBe(true)
  })

  it('always offers something to do', () => {
    for (const isIos of [true, false]) {
      const causes = connectionCauses({ isIos })
      expect(causes.length).toBeGreaterThanOrEqual(3)
      expect(causes.every((c) => c.heading && c.body)).toBe(true)
    }
  })

  it('waits long enough that a roam or a restart never triggers it', () => {
    // Access-point roams and box restarts resolve in seconds. Explaining
    // those would be noise, and noise is what makes people ignore the real
    // one later.
    expect(STUCK_AFTER_MS).toBeGreaterThanOrEqual(15_000)
    expect(STUCK_AFTER_MS).toBeLessThanOrEqual(60_000)
  })
})
